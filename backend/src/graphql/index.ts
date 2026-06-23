/**
 * Mounts the GraphQL endpoint on an Express router.
 *
 * Endpoint: POST /api/graphql
 *
 * Uses `graphql-http` (spec-compliant, no Apollo overhead).
 * Introspection is disabled in production to reduce attack surface.
 *
 * Security:
 *  - Depth limit: rejects queries nested deeper than MAX_DEPTH (default 6,
 *    configurable via GRAPHQL_MAX_DEPTH env var)
 *  - Complexity limit: rejects queries whose cost score exceeds MAX_COMPLEXITY
 *    (default 100, configurable via GRAPHQL_MAX_COMPLEXITY env var). List
 *    fields are scored at LIST_FIELD_COST (default 10) to account for fan-out;
 *    scalar/object fields cost 1 each.
 *  - No mutations exposed — all writes go through the existing REST layer
 *  - Rate limiting is inherited from the global Express rate limiter in index.ts
 */

import { Router } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import {
  buildSchema,
  execute,
  subscribe,
  getOperationAST,
  GraphQLError,
  parse,
  validate,
} from "graphql";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import type { Server } from "http";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import {
  extractTenantFromJwt,
  type TenantContext,
} from "../middleware/tenancy";

const MAX_DEPTH = parseInt(process.env.GRAPHQL_MAX_DEPTH ?? "6", 10);
const MAX_COMPLEXITY = parseInt(
  process.env.GRAPHQL_MAX_COMPLEXITY ?? "100",
  10
);
// Fields returning lists are more expensive due to N-row fan-out.
const LIST_FIELD_COST = parseInt(
  process.env.GRAPHQL_LIST_FIELD_COST ?? "10",
  10
);

/** Fields known to return lists (fan-out multiplier applied). */
const LIST_FIELDS = new Set([
  "tokens",
  "burnRecords",
  "streams",
  "proposals",
  "votes",
  "campaigns",
]);

function maxQueryDepth(node: any, depth = 0): number {
  if (!node || typeof node !== "object") return depth;
  if (node.selectionSet?.selections) {
    return Math.max(
      ...node.selectionSet.selections.map((s: any) =>
        maxQueryDepth(s, depth + 1)
      )
    );
  }
  return depth;
}

/**
 * Recursively compute a cost score for a selection set node.
 * Each field costs 1; list fields cost LIST_FIELD_COST to account for N-row
 * fan-out. The cost accumulates across all nested selections.
 */
function queryComplexity(node: any): number {
  if (!node || typeof node !== "object") return 0;
  if (!node.selectionSet?.selections) return 1;

  let cost = 0;
  for (const selection of node.selectionSet.selections) {
    const fieldName: string | undefined = selection.name?.value;
    const fieldCost =
      fieldName && LIST_FIELDS.has(fieldName) ? LIST_FIELD_COST : 1;
    cost += fieldCost + queryComplexity(selection);
  }
  return cost;
}

export const schema = buildSchema(typeDefs);

// `buildSchema` produces a schema with no executable resolvers. Queries are
// served via `rootValue` (graphql-http, below), but subscription fields need
// their `subscribe`/`resolve` functions attached directly to the schema so the
// graphql-ws transport can drive them.
const subscriptionType = schema.getSubscriptionType();
if (subscriptionType) {
  const fields = subscriptionType.getFields();
  for (const [name, def] of Object.entries(resolvers.Subscription)) {
    const field = fields[name];
    if (field) {
      (field as any).subscribe = def.subscribe;
      (field as any).resolve = def.resolve;
    }
  }
}

/** Flat rootValue merging all resolver namespaces for graphql-http. */
const rootValue = {
  ...resolvers.Query,
  // Field resolvers for nested types are handled inside the Query resolvers
  // by fetching relations lazily (see resolvers.ts Token.burnRecords etc.)
};

// ---------------------------------------------------------------------------
// GraphQL-WS subscription transport
// ---------------------------------------------------------------------------

/** Max concurrent subscription operations per WebSocket connection — guards
 *  against subscription amplification from a single client. */
const MAX_SUBSCRIPTIONS_PER_CONNECTION = parseInt(
  process.env.GRAPHQL_MAX_SUBSCRIPTIONS_PER_CONNECTION ?? "10",
  10
);

interface ConnectionExtra {
  tenant?: TenantContext;
  /** IDs of in-flight subscription operations counted toward the cap. */
  activeSubscriptionIds: Set<string>;
}

/**
 * Resolve the tenant from graphql-ws `connection_init` payload using the same
 * JWT validation as the REST tenancy middleware. Accepts the token via an
 * `authorization` / `Authorization` ("Bearer <jwt>") field or a bare
 * `authToken` field. Returns null when no valid tenant can be derived.
 */
function resolveTenantFromConnectionParams(
  params: Record<string, unknown> | undefined
): TenantContext | null {
  if (!params) return null;
  const secret = process.env.JWT_SECRET ?? "dev-secret-key";

  const raw = params.authorization ?? params.Authorization ?? params.authToken;
  if (typeof raw !== "string" || raw.length === 0) return null;

  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  return extractTenantFromJwt(token, secret);
}

/** True when the incoming operation is a `subscription` (vs query/mutation). */
function isSubscriptionOperation(
  query: string,
  operationName?: string | null
): boolean {
  try {
    const op = getOperationAST(parse(query), operationName ?? undefined);
    return op?.operation === "subscription";
  } catch {
    return false;
  }
}

/**
 * Attach the graphql-ws subscription server to the existing HTTP server on the
 * `/graphql` WebSocket path. Authentication + tenant resolution happen on the
 * `connection_init` handshake; unauthenticated connections are rejected.
 */
export function attachGraphqlSubscriptions(
  httpServer: Server
): WebSocketServer {
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  useServer(
    {
      schema,
      execute,
      subscribe,
      rootValue,

      // Validate the JWT on the connection_init handshake and stash the tenant.
      onConnect: (ctx) => {
        const tenant = resolveTenantFromConnectionParams(
          ctx.connectionParams as Record<string, unknown> | undefined
        );
        if (!tenant) return false; // reject handshake → 4403 Forbidden close

        const extra = ctx.extra as unknown as ConnectionExtra;
        extra.tenant = tenant;
        extra.activeSubscriptionIds = new Set();
        return true;
      },

      // Expose the resolved tenant to subscription resolvers.
      context: (ctx) => ({
        tenant: (ctx.extra as unknown as ConnectionExtra)?.tenant,
      }),

      // Enforce the per-connection concurrent-subscription cap.
      onSubscribe: (ctx, msg) => {
        if (
          !isSubscriptionOperation(msg.payload.query, msg.payload.operationName)
        ) {
          return undefined; // queries/mutations don't count toward the cap
        }
        const extra = ctx.extra as unknown as ConnectionExtra;
        if (
          extra.activeSubscriptionIds.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          return [
            new GraphQLError(
              `Subscription limit of ${MAX_SUBSCRIPTIONS_PER_CONNECTION} concurrent subscriptions per connection exceeded`
            ),
          ];
        }
        extra.activeSubscriptionIds.add(msg.id);
        return undefined;
      },

      // onComplete/onError fire for every operation; only release IDs we counted.
      onComplete: (ctx, msg) => {
        (
          ctx.extra as unknown as ConnectionExtra
        )?.activeSubscriptionIds?.delete(msg.id);
      },

      onError: (ctx, msg) => {
        (
          ctx.extra as unknown as ConnectionExtra
        )?.activeSubscriptionIds?.delete(msg.id);
      },
    },
    wsServer
  );

  console.log("[GraphQL-WS] Subscription server attached at /graphql");
  return wsServer;
}

const router = Router();

router.all(
  "/",
  createHandler({
    schema,
    rootValue,
    onSubscribe(_req, params) {
      // Disable introspection in production
      if (
        process.env.NODE_ENV === "production" &&
        typeof params.query === "string" &&
        params.query.includes("__schema")
      ) {
        return [new GraphQLError("Introspection is disabled in production")];
      }

      if (typeof params.query === "string") {
        try {
          const doc = parse(params.query);
          const errors = validate(schema, doc);
          if (errors.length) return errors;

          const depth = Math.max(
            ...doc.definitions.map((def: any) => maxQueryDepth(def))
          );
          if (depth > MAX_DEPTH) {
            return [
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${MAX_DEPTH}`
              ),
            ];
          }

          const complexity = doc.definitions.reduce(
            (sum: number, def: any) => sum + queryComplexity(def),
            0
          );
          if (complexity > MAX_COMPLEXITY) {
            return [
              new GraphQLError(
                `Query complexity ${complexity} exceeds maximum allowed budget of ${MAX_COMPLEXITY}`
              ),
            ];
          }
        } catch {
          return [new GraphQLError("Failed to parse query")];
        }
      }

      return undefined;
    },
  })
);

export default router;
