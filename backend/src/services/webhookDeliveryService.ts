import axios, { AxiosError } from "axios";
import { gzip } from "zlib";
import { promisify } from "util";
import {
  WebhookSubscription,
  WebhookPayload,
  WebhookEventType,
  WebhookEventData,
} from "../types/webhook";
import webhookService from "./webhookService";
import webhookDeadLetterService from "./webhookDeadLetterService";
import { IntegrationMetrics } from "../monitoring/metrics/prometheus-config";
import { webhookDeliveryLatency } from "../lib/metrics";
import { CircuitBreaker } from "../lib/circuitBreaker";
import tenantWebhookRateLimiter, {
  TenantWebhookRateLimiter,
} from "./tenantWebhookRateLimiter";

const gzipAsync = promisify(gzip);

const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "5000");
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || "3");
const RETRY_DELAY_MS = parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000");

export class WebhookDeliveryService {
  private circuitBreaker: CircuitBreaker;
  // Read at construction time so tests can override via process.env before new WebhookDeliveryService()
  private readonly compressionThresholdBytes: number;
  // Per-tenant token-bucket rate limiter gating outbound delivery. Defaults
  // to the shared singleton so all callers in the process share state, but
  // can be overridden (e.g. in tests) via the constructor.
  private readonly rateLimiter: TenantWebhookRateLimiter;

  constructor(rateLimiter: TenantWebhookRateLimiter = tenantWebhookRateLimiter) {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_FAILURE_THRESHOLD || "5"),
      successThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_SUCCESS_THRESHOLD || "2"),
      timeoutMs: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_TIMEOUT_MS || "60000"),
    });
    // Payloads larger than this threshold (bytes) are gzip-compressed on delivery.
    this.compressionThresholdBytes = parseInt(
      process.env.WEBHOOK_COMPRESSION_THRESHOLD_BYTES || "1024"
    );
    this.rateLimiter = rateLimiter;
  }

  /**
   * Resolve the rate-limiter "tenant" key for a subscription.
   *
   * There is no dedicated tenant/org column on webhook subscriptions in
   * this codebase (see `types/webhook.ts` / `services/webhookService.ts`) —
   * `createdBy` (the address that registered the subscription) is the
   * closest existing identifier scoping a subscription to one account, so
   * it is used as the tenant key. Centralizing the lookup here means a
   * future real tenant/org concept only requires changing this one method.
   */
  private getTenantId(subscription: WebhookSubscription): string {
    return subscription.createdBy;
  }
  /**
   * Trigger webhooks for an event
   */
  async triggerEvent(
    event: WebhookEventType,
    data: WebhookEventData,
    tokenAddress?: string,
    correlationId?: string
  ): Promise<void> {
    const subscriptions = await webhookService.findMatchingSubscriptions(
      event,
      tokenAddress
    );

    const cid = correlationId || `whk_${Date.now().toString(36)}`;
    console.log(
      JSON.stringify({ event: 'webhook.trigger', correlationId: cid, webhookEvent: event, subscriptionCount: subscriptions.length })
    );

    // Deliver webhooks in parallel
    await Promise.allSettled(
      subscriptions.map((subscription) =>
        this.deliverWebhook(subscription, event, data, cid)
      )
    );
  }

  /**
   * Deliver webhook to a single subscription with circuit breaker and retry logic
   * @internal
   */
  async deliverWebhook(
    subscription: WebhookSubscription,
    event: WebhookEventType,
    data: WebhookEventData,
    correlationId?: string
  ): Promise<void> {
    const payload = webhookService.createPayload(
      event,
      data,
      subscription.secret
    );

    const cid = correlationId || `whk_${Date.now().toString(36)}`;
    // Attach correlation ID to payload headers (not body — body is signed)
    const extraHeaders: Record<string, string> = {
      'X-Correlation-Id': cid,
    };
    // Include originating tx hash if present in data
    const txHash = (data as unknown as Record<string, unknown>).transactionHash as string | undefined;
    if (txHash) extraHeaders['X-Tx-Hash'] = txHash;

    // Per-tenant token-bucket rate limiting gate — applied BEFORE any
    // outbound HTTP call. If the tenant is within budget this resolves
    // immediately; otherwise the delivery is queued (never dropped) and
    // resolves once a token refills (see TenantWebhookRateLimiter).
    const tenantId = this.getTenantId(subscription);
    await this.rateLimiter.acquire(tenantId);

    return this.circuitBreaker.execute(async () => {
      let lastError: string | null = null;
      let statusCode: number | null = null;
      let success = false;
      let attempts = 0;
      const startMs = Date.now();

      const rawBody = JSON.stringify(payload);
      const useCompression = Buffer.byteLength(rawBody, "utf8") >= this.compressionThresholdBytes;
      let compressedBody: Buffer | null = null;
      if (useCompression) {
        compressedBody = await gzipAsync(rawBody) as Buffer;
      }

      // Track whether to fall back to uncompressed (e.g. after a 415 response)
      let compressionDisabled = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        attempts = attempt;
        try {
          console.log(
            JSON.stringify({ event: 'webhook.attempt', correlationId: cid, url: subscription.url, attempt, maxRetries: MAX_RETRIES, compressed: useCompression && !compressionDisabled, ...(txHash && { txHash }) })
          );

          const sendCompressed = useCompression && !compressionDisabled && compressedBody !== null;
          const requestBody = sendCompressed ? compressedBody : rawBody;
          const contentHeaders: Record<string, string> = sendCompressed
            ? { "Content-Type": "application/json", "Content-Encoding": "gzip" }
            : { "Content-Type": "application/json" };

          const response = await axios.post(subscription.url, requestBody, {
            timeout: TIMEOUT_MS,
            headers: {
              ...contentHeaders,
              "X-Webhook-Signature": payload.signature,
              "X-Webhook-Event": event,
              "User-Agent": "Nova-Launch-Webhook/1.0",
              ...extraHeaders,
            },
            validateStatus: (status) => status >= 200 && status < 300,
          });

          statusCode = response.status;
          success = true;
          lastError = null;

          console.log(
            JSON.stringify({ event: 'webhook.delivered', correlationId: cid, url: subscription.url, statusCode, ...(txHash && { txHash }) })
          );

          // Update last triggered timestamp
          await webhookService.updateLastTriggered(subscription.id);

          break; // Success, exit retry loop
        } catch (error) {
          const axiosError = error as AxiosError;
          statusCode = axiosError.response?.status || null;
          lastError = axiosError.message;

          console.error(
            JSON.stringify({ event: 'webhook.failed', correlationId: cid, url: subscription.url, attempt, statusCode, error: lastError, ...(txHash && { txHash }) })
          );

          // 415 Unsupported Media Type — consumer cannot accept encoded content;
          // disable compression and retry with the uncompressed body.
          if (statusCode === 415 && useCompression && !compressionDisabled) {
            compressionDisabled = true;
            continue;
          }

          // Other 4xx errors are non-retryable — stop immediately
          if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
            break;
          }

          // Wait before retrying (exponential backoff)
          if (attempt < MAX_RETRIES) {
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
          }
        }
      }

      // Emit delivery metrics
      const durationMs = Date.now() - startMs;
      const retries = attempts - 1;
      const outcome = success ? 'success' : (attempts >= MAX_RETRIES ? 'exhausted' : 'failed');
      IntegrationMetrics.recordWebhookDelivery(event, outcome, durationMs, retries);

      // Observe end-to-end latency histogram with outcome and attempt count labels.
      webhookDeliveryLatency.observe(
        { outcome, attempt_count: String(attempts) },
        durationMs / 1000
      );

      // Log the delivery attempt
      await webhookService.logDelivery(
        subscription.id,
        event,
        payload,
        statusCode,
        success,
        attempts,
        lastError
      );

      // Route exhausted deliveries to dead-letter store
      if (!success && attempts >= MAX_RETRIES) {
        try {
          const deadLetterId = await webhookDeadLetterService.storeDeadLetter(
            subscription.id,
            event,
            payload,
            statusCode,
            lastError,
            attempts
          );
          IntegrationMetrics.recordWebhookDeadLetter(event);
          console.warn(
            JSON.stringify({ event: 'webhook.deadletter', correlationId: cid, deadLetterId, subscriptionId: subscription.id, attempts: MAX_RETRIES, ...(txHash && { txHash }) })
          );
        } catch (dlError) {
          console.error(
            JSON.stringify({ event: 'webhook.deadletter.error', correlationId: cid, subscriptionId: subscription.id, error: dlError })
          );
        }
      } else if (!success) {
        console.warn(
          JSON.stringify({ event: 'webhook.failed', correlationId: cid, subscriptionId: subscription.id, attempts, ...(txHash && { txHash }) })
        );
      }
    });
  }

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Test webhook delivery (for testing endpoints)
   */
  async testWebhook(subscription: WebhookSubscription): Promise<boolean> {
    const testPayload = webhookService.createPayload(
      WebhookEventType.TOKEN_CREATED,
      {
        tokenAddress: "GTEST...",
        creator: "GTEST...",
        name: "Test Token",
        symbol: "TEST",
        decimals: 7,
        initialSupply: "1000000",
        transactionHash: "test-hash",
        ledger: 12345,
      },
      subscription.secret
    );

    try {
      const response = await axios.post(subscription.url, testPayload, {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": testPayload.signature,
          "X-Webhook-Event": "test",
          "User-Agent": "Nova-Launch-Webhook/1.0",
        },
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error("Test webhook failed:", error);
      return false;
    }
  }
}

export default new WebhookDeliveryService();
