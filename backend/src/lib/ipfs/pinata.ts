import pinataSDK from "@pinata/sdk";
import NodeCache from "node-cache";
import { Counter } from "prom-client";
import { CircuitBreaker } from "../circuitBreaker.js";
import { register } from "../metrics/index.js";
import {
  verifyCIDContent,
  verifyMetadataCID,
  verifyRetrievedContent,
  CIDMismatchError,
} from "./cidVerification.js";
import { pinataQueue, type PinataQueueMetrics } from "./pinataQueue.js";

const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

const ipfsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30000, // 30 seconds before retry
});

const PINATA_BASE_URL = "https://api.pinata.cloud";
const CREDENTIAL_VALIDATION_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Prometheus metric: metadata.cid_mismatch counter
// ---------------------------------------------------------------------------

export const metadataCidMismatchCounter = new Counter({
  name: "metadata_cid_mismatch_total",
  help: "Total number of CID integrity mismatches detected on metadata retrieval",
  labelNames: ["cid"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Credentials management
// ---------------------------------------------------------------------------

interface PinataCredentials {
  apiKey: string;
  apiSecret: string;
}

let activeCredentials: PinataCredentials = {
  apiKey: process.env.PINATA_API_KEY ?? "",
  apiSecret: process.env.PINATA_API_SECRET ?? "",
};

// Optional hot-swap credentials. If the deployment environment provides
// PINATA_API_KEY_NEXT and PINATA_API_SECRET_NEXT before the first Pinata call,
// the system validates them and promotes them to live credentials at runtime.
let stagedCredentials: PinataCredentials | null =
  process.env.PINATA_API_KEY_NEXT && process.env.PINATA_API_SECRET_NEXT
    ? {
        apiKey: process.env.PINATA_API_KEY_NEXT,
        apiSecret: process.env.PINATA_API_SECRET_NEXT,
      }
    : null;

function ensureActiveCredentials(): void {
  if (!activeCredentials.apiKey || !activeCredentials.apiSecret) {
    throw new Error("Pinata credentials are not configured");
  }
}

function setActiveCredentials(credentials: PinataCredentials): void {
  activeCredentials = credentials;
  process.env.PINATA_API_KEY = credentials.apiKey;
  process.env.PINATA_API_SECRET = credentials.apiSecret;
}

async function getPinataClient(): Promise<any> {
  if (stagedCredentials) {
    const valid = await validatePinataCredentials(
      stagedCredentials.apiKey,
      stagedCredentials.apiSecret
    );
    if (valid) {
      setActiveCredentials(stagedCredentials);
      stagedCredentials = null;
      console.info(
        "Pinata credentials rotation: new credentials validated and activated"
      );
    } else if (!activeCredentials.apiKey || !activeCredentials.apiSecret) {
      throw new Error("Pinata credentials are not configured and staged credentials failed validation");
    } else {
      console.warn(
        "Pinata credential rotation: staged credentials failed validation, continuing with active credentials"
      );
    }
  }

  ensureActiveCredentials();
  return new pinataSDK(activeCredentials.apiKey, activeCredentials.apiSecret);
}

export async function validatePinataCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  try {
    const url = `${PINATA_BASE_URL}/data/pinList?status=pinned&limit=1`;
    const response = await fetch(url, {
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: apiSecret,
      },
      signal: AbortSignal.timeout(CREDENTIAL_VALIDATION_TIMEOUT_MS),
    });

    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function rotatePinataCredentials(
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const valid = await validatePinataCredentials(apiKey, apiSecret);
  if (!valid) {
    throw new Error("Pinata credential validation failed");
  }

  setActiveCredentials({ apiKey, apiSecret });
}

export function getActivePinataCredentials(): PinataCredentials {
  ensureActiveCredentials();
  return { ...activeCredentials };
}

// ---------------------------------------------------------------------------
// Upload-time CID verification config
// ---------------------------------------------------------------------------

// Set IPFS_VERIFY_CID=true to enable content-address integrity checks after upload.
const CID_VERIFY_ENABLED = process.env.IPFS_VERIFY_CID === "true";
const CID_VERIFY_GATEWAY =
  process.env.IPFS_VERIFY_GATEWAY_URL ?? "https://gateway.pinata.cloud/ipfs";

// ---------------------------------------------------------------------------
// Re-pin from trusted gateway
// ---------------------------------------------------------------------------

/**
 * Re-pin a CID from the trusted public IPFS gateway via Pinata's pinByHash API.
 *
 * Called automatically when a CID mismatch is detected on retrieval.
 */
export async function rePinFromGateway(cid: string): Promise<void> {
  const pinata = await getPinataClient();
  await pinata.pinByHash(cid, {
    pinataMetadata: { name: `repin-${cid}` },
  });
  console.info(`[pinata] Successfully re-pinned CID ${cid} from gateway`);
}

// ---------------------------------------------------------------------------
// Upload operations
// ---------------------------------------------------------------------------

export async function uploadImageToIPFS(
  buffer: Buffer,
  filename: string
): Promise<string> {
  return ipfsCircuitBreaker.execute(() =>
    pinataQueue.enqueue(async () => {
      const pinata = await getPinataClient();

      const result = await pinata.pinFileToIPFS(buffer, {
        pinataMetadata: { name: filename },
      });

      const cid = result.IpfsHash;

      if (CID_VERIFY_ENABLED) {
        await verifyCIDContent(buffer, cid, CID_VERIFY_GATEWAY);
      }

      return cid;
    })
  );
}

export async function uploadMetadataToIPFS(metadata: any): Promise<string> {
  return ipfsCircuitBreaker.execute(() =>
    pinataQueue.enqueue(async () => {
      const pinata = await getPinataClient();

      const result = await pinata.pinJSONToIPFS(metadata);
      const cid = result.IpfsHash;

      if (CID_VERIFY_ENABLED) {
        await verifyMetadataCID(metadata, cid, CID_VERIFY_GATEWAY);
      }

      // Cache the metadata
      cache.set(cid, metadata);

      return cid;
    })
  );
}

// ---------------------------------------------------------------------------
// Retrieval with integrity verification
// ---------------------------------------------------------------------------

// Set IPFS_VERIFY_RETRIEVAL=true to enable CID integrity checks on every fetch.
const CID_VERIFY_RETRIEVAL_ENABLED =
  process.env.IPFS_VERIFY_RETRIEVAL !== "false"; // on by default

/**
 * Track CIDs currently undergoing re-pin so callers get 503 until complete.
 */
const rePinInProgress = new Set<string>();

export async function getMetadataFromIPFS(cid: string): Promise<any> {
  // Check cache first
  const cached = cache.get(cid);
  if (cached) return cached;

  // Reject immediately while a re-pin is in progress for this CID
  if (rePinInProgress.has(cid)) {
    throw new CIDMismatchError(
      cid,
      "Re-pin in progress — content unavailable until integrity is restored"
    );
  }

  // Fetch from IPFS with circuit breaker + queue throttle
  return ipfsCircuitBreaker.execute(() =>
    pinataQueue.enqueue(async () => {
      const response = await fetch(
        `${CID_VERIFY_GATEWAY}/${cid}`
      );
      if (!response.ok) throw new Error("Metadata not found");

      const rawBuffer = Buffer.from(await response.arrayBuffer());

      if (CID_VERIFY_RETRIEVAL_ENABLED) {
        await verifyRetrievedContent(rawBuffer, cid, {
          gatewayBaseUrl: CID_VERIFY_GATEWAY,
          onMismatch: (cidVal, trustedHash, retrievedHash) => {
            metadataCidMismatchCounter.inc({ cid: cidVal });
            console.error(
              `[pinata] metadata.cid_mismatch: cid=${cidVal} ` +
                `trusted=${trustedHash} retrieved=${retrievedHash}`
            );
            rePinInProgress.add(cidVal);
          },
          rePinFromGateway: async (cidVal) => {
            try {
              await rePinFromGateway(cidVal);
              // Evict in-memory cache so next request fetches fresh content
              cache.del(cidVal);
            } finally {
              rePinInProgress.delete(cidVal);
            }
          },
        });
      }

      const metadata = JSON.parse(rawBuffer.toString("utf8"));
      cache.set(cid, metadata);

      return metadata;
    })
  );
}

// ---------------------------------------------------------------------------
// Observability helpers
// ---------------------------------------------------------------------------

/**
 * Get the current state of the IPFS circuit breaker (for monitoring/debugging).
 */
export function getIPFSCircuitBreakerMetrics() {
  return ipfsCircuitBreaker.getMetrics();
}

/**
 * Manually reset the IPFS circuit breaker (admin use only).
 */
export function resetIPFSCircuitBreaker(): void {
  ipfsCircuitBreaker.reset();
}

/**
 * Get a snapshot of the Pinata request queue metrics.
 * Useful for observability dashboards and health checks.
 *
 * Returns: { queueDepth, inFlight, throttledCount, retried429Count, avgLatencyMs }
 */
export function getPinataQueueMetrics(): PinataQueueMetrics {
  return pinataQueue.getMetrics();
}

export { CIDMismatchError };
