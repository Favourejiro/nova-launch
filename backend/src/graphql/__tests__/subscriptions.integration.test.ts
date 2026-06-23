/**
 * Integration test for GraphQL subscriptions over the graphql-ws transport.
 *
 * Spins up a real HTTP server with the graphql-ws subscription server attached,
 * connects a graphql-ws client over a WebSocket, authenticates on the
 * connection_init handshake with a tenant-scoped JWT, subscribes, triggers an
 * event through the shared eventBus, and asserts the payload is delivered.
 *
 * Prisma is mocked because importing the graphql module loads resolvers.ts
 * (which imports prisma); no database connection is made.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createClient, type Client } from "graphql-ws";
import jwt from "jsonwebtoken";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn(), findMany: vi.fn() },
    burnRecord: { findMany: vi.fn() },
    stream: { findUnique: vi.fn(), findMany: vi.fn() },
    proposal: { findUnique: vi.fn(), findMany: vi.fn() },
    vote: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

const JWT_SECRET = "test-subscription-secret";
process.env.JWT_SECRET = JWT_SECRET;

const TENANT = "GCREATOR_INTEGRATION";

// Imported after env + mocks are set up.
let attachGraphqlSubscriptions: typeof import("../index").attachGraphqlSubscriptions;
let eventBus: typeof import("../../services/eventBus").eventBus;
let SUBSCRIPTION_TOPICS: typeof import("../resolvers").SUBSCRIPTION_TOPICS;

let server: Server;
let url: string;

function tokenFor(tenantId: string): string {
  return jwt.sign({ tenantId }, JWT_SECRET, { expiresIn: "5m" });
}

function makeClient(connectionParams: Record<string, unknown>): Client {
  return createClient({
    url,
    webSocketImpl: WebSocket,
    connectionParams,
    retryAttempts: 0,
  });
}

/** Subscribe and resolve with the first `next` payload (or reject on error). */
function firstEvent(
  client: Client,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const dispose = client.subscribe(
      { query, variables },
      {
        next: (data) => {
          resolve(data);
          dispose();
        },
        error: reject,
        complete: () => {},
      }
    );
  });
}

beforeAll(async () => {
  ({ attachGraphqlSubscriptions } = await import("../index"));
  ({ eventBus } = await import("../../services/eventBus"));
  ({ SUBSCRIPTION_TOPICS } = await import("../resolvers"));

  server = createServer();
  attachGraphqlSubscriptions(server);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  url = `ws://localhost:${port}/graphql`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("GraphQL subscriptions over graphql-ws", () => {
  it("delivers a tokenDeployed event to an authenticated subscriber", async () => {
    const client = makeClient({ authorization: `Bearer ${tokenFor(TENANT)}` });

    const received = firstEvent(
      client,
      `subscription {
        tokenDeployed {
          tokenAddress
          creatorAddress
          name
          symbol
          totalSupply
        }
      }`
    );

    // Give the subscription a moment to register on the server.
    await new Promise((r) => setTimeout(r, 100));

    await eventBus.publish(SUBSCRIPTION_TOPICS.tokenDeployed, {
      tokenAddress: "CINTEG1",
      creatorAddress: TENANT,
      name: "Integration Token",
      symbol: "INT",
      totalSupply: BigInt("4200000000"),
      txHash: "hashI",
      timestamp: "2026-06-23T00:00:00.000Z",
    });

    const result = await received;
    expect(result.data.tokenDeployed).toEqual({
      tokenAddress: "CINTEG1",
      creatorAddress: TENANT,
      name: "Integration Token",
      symbol: "INT",
      totalSupply: "4200000000",
    });

    client.dispose();
  });

  it("does not deliver another tenant's events", async () => {
    const client = makeClient({ authorization: `Bearer ${tokenFor(TENANT)}` });

    let delivered = false;
    const dispose = client.subscribe(
      { query: `subscription { burnExecuted { tokenAddress amount } }` },
      { next: () => (delivered = true), error: () => {}, complete: () => {} }
    );

    await new Promise((r) => setTimeout(r, 100));

    await eventBus.publish(SUBSCRIPTION_TOPICS.burnExecuted, {
      tokenAddress: "COTHER",
      creatorAddress: "GSOMEONE_ELSE",
      amount: BigInt("100"),
      burnedBy: "GX",
      isAdminBurn: false,
      txHash: "h",
      timestamp: "2026-06-23T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(delivered).toBe(false);

    dispose();
    client.dispose();
  });

  it("rejects a connection with no/invalid JWT", async () => {
    const client = makeClient({});

    await expect(
      firstEvent(client, `subscription { tokenDeployed { tokenAddress } }`)
    ).rejects.toBeDefined();

    client.dispose();
  });
});
