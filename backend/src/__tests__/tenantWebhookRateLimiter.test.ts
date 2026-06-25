/**
 * Tests for TenantWebhookRateLimiter — the per-tenant token-bucket rate
 * limiter gating outbound webhook delivery (Issue #1336).
 *
 * Covers:
 *   - Default config (100/min, burst 20) is read from env vars at construction.
 *   - Burst capacity is respected: the first `burstCapacity` acquisitions
 *     resolve immediately; the next one is queued, not dropped.
 *   - Queued acquisitions eventually resolve once tokens refill (using
 *     vi.useFakeTimers() to advance time deterministically).
 *   - Tenants are isolated: one tenant's exhausted bucket never blocks or
 *     drains tokens from another tenant's bucket.
 *   - Per-tenant overrides (setTenantOverride/clearTenantOverride) work as
 *     the documented extension point for future settings-table integration.
 *   - Metrics (webhook_delivery_queued_total / webhook_delivery_rate_limited_total)
 *     are incremented per tenant exactly when deliveries are queued/rate-limited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("TenantWebhookRateLimiter", () => {
  let TenantWebhookRateLimiter: typeof import("../services/tenantWebhookRateLimiter").TenantWebhookRateLimiter;
  let webhookDeliveryQueuedTotal: typeof import("../services/tenantWebhookRateLimiter").webhookDeliveryQueuedTotal;
  let webhookDeliveryRateLimitedTotal: typeof import("../services/tenantWebhookRateLimiter").webhookDeliveryRateLimitedTotal;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../services/tenantWebhookRateLimiter");
    TenantWebhookRateLimiter = mod.TenantWebhookRateLimiter;
    webhookDeliveryQueuedTotal = mod.webhookDeliveryQueuedTotal;
    webhookDeliveryRateLimitedTotal = mod.webhookDeliveryRateLimitedTotal;
    webhookDeliveryQueuedTotal.reset();
    webhookDeliveryRateLimitedTotal.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Defaults / configuration
  // -------------------------------------------------------------------------

  describe("default configuration", () => {
    it("defaults to 100/min and burst 20 when no env vars are set", () => {
      delete process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE;
      delete process.env.WEBHOOK_RATE_LIMIT_BURST;
      const limiter = new TenantWebhookRateLimiter();
      const config = limiter.getConfigForTenant("tenant-a");
      expect(config.ratePerMinute).toBe(100);
      expect(config.burstCapacity).toBe(20);
      limiter.destroy();
    });

    it("reads defaults from WEBHOOK_RATE_LIMIT_PER_MINUTE / WEBHOOK_RATE_LIMIT_BURST env vars", async () => {
      process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "240";
      process.env.WEBHOOK_RATE_LIMIT_BURST = "5";
      vi.resetModules();
      const mod = await import("../services/tenantWebhookRateLimiter");
      const limiter = new mod.TenantWebhookRateLimiter();
      const config = limiter.getConfigForTenant("tenant-a");
      expect(config.ratePerMinute).toBe(240);
      expect(config.burstCapacity).toBe(5);
      limiter.destroy();
      delete process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE;
      delete process.env.WEBHOOK_RATE_LIMIT_BURST;
    });
  });

  // -------------------------------------------------------------------------
  // Burst behavior — immediate vs queued
  // -------------------------------------------------------------------------

  describe("burst capacity", () => {
    it("allows exactly burstCapacity immediate acquisitions before queuing", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });
      const tenant = "tenant-burst";

      const resolvedFlags: boolean[] = [];
      const promises = Array.from({ length: 20 }, () => {
        const p = limiter.acquire(tenant).then(() => {
          resolvedFlags.push(true);
        });
        return p;
      });

      await Promise.all(promises);
      expect(resolvedFlags).toHaveLength(20);
      // Bucket should now be empty (0 tokens, modulo negligible elapsed-time refill)
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      limiter.destroy();
    });

    it("queues the (burstCapacity + 1)th acquisition instead of dropping it", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec — easy to reason about
        burstCapacity: 3,
      });
      const tenant = "tenant-overflow";

      // Consume all 3 burst tokens immediately.
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      // The 4th acquisition must NOT resolve immediately — it should queue.
      let fourthResolved = false;
      const fourth = limiter.acquire(tenant).then(() => {
        fourthResolved = true;
      });

      // Give pending microtasks a chance to run without advancing real time.
      await Promise.resolve();
      await Promise.resolve();
      expect(fourthResolved).toBe(false);
      expect(limiter.getQueueLength(tenant)).toBe(1);

      // Advance fake time by 1 token's worth (1000ms at 60/min) plus the
      // drain-check interval so the queued caller is resolved, not dropped.
      await vi.advanceTimersByTimeAsync(1100);

      expect(fourthResolved).toBe(true);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      limiter.destroy();
    });

    it("never drops excess deliveries — all queued callers eventually resolve", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec
        burstCapacity: 2,
      });
      const tenant = "tenant-no-drop";

      const TOTAL_REQUESTS = 10;
      let resolvedCount = 0;
      const promises = Array.from({ length: TOTAL_REQUESTS }, () =>
        limiter.acquire(tenant).then(() => {
          resolvedCount++;
        })
      );

      // Immediately, only burstCapacity (2) should be resolved; the rest queued.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolvedCount).toBe(2);
      expect(limiter.getQueueLength(tenant)).toBe(TOTAL_REQUESTS - 2);

      // Advance time enough for all remaining tokens to refill (8 more
      // tokens at 1/sec => ~8s, with margin for the drain check interval).
      await vi.advanceTimersByTimeAsync(9000);

      expect(resolvedCount).toBe(TOTAL_REQUESTS);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      await Promise.all(promises);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("one tenant exhausting its bucket does not affect another tenant", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 2,
      });

      // Exhaust tenant A's bucket and queue 3 more.
      await limiter.acquire("tenant-a");
      await limiter.acquire("tenant-a");
      let aResolvedExtra = false;
      limiter.acquire("tenant-a").then(() => {
        aResolvedExtra = true;
      });
      await Promise.resolve();
      expect(limiter.getQueueLength("tenant-a")).toBe(1);
      expect(aResolvedExtra).toBe(false);

      // Tenant B should still have its full burst capacity available.
      expect(limiter.getAvailableTokens("tenant-b")).toBe(2);
      let bResolved = false;
      await limiter.acquire("tenant-b").then(() => {
        bResolved = true;
      });
      expect(bResolved).toBe(true);
      expect(limiter.getQueueLength("tenant-b")).toBe(0);

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Per-tenant overrides — the documented extension point
  // -------------------------------------------------------------------------

  describe("per-tenant overrides", () => {
    it("setTenantOverride changes the effective config for that tenant only", () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.setTenantOverride("vip-tenant", {
        ratePerMinute: 1000,
        burstCapacity: 100,
      });

      expect(limiter.getConfigForTenant("vip-tenant")).toEqual({
        ratePerMinute: 1000,
        burstCapacity: 100,
      });
      expect(limiter.getConfigForTenant("regular-tenant")).toEqual({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.destroy();
    });

    it("clearTenantOverride reverts a tenant back to the default config", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.setTenantOverride("temp-tenant", {
        ratePerMinute: 5,
        burstCapacity: 1,
      });
      expect(limiter.getConfigForTenant("temp-tenant").burstCapacity).toBe(1);

      limiter.clearTenantOverride("temp-tenant");
      expect(limiter.getConfigForTenant("temp-tenant")).toEqual({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.destroy();
    });

    it("a lowered override clamps existing tokens down to the new burst capacity", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });
      const tenant = "shrinking-tenant";

      // Touch the bucket so it's created with the default 20-token capacity.
      expect(limiter.getAvailableTokens(tenant)).toBe(20);

      limiter.setTenantOverride(tenant, { ratePerMinute: 100, burstCapacity: 3 });
      expect(limiter.getAvailableTokens(tenant)).toBeLessThanOrEqual(3);

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  describe("metrics", () => {
    it("does NOT increment queued/rate_limited metrics while under budget", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      await limiter.acquire("metrics-tenant-ok");
      await limiter.acquire("metrics-tenant-ok");

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const rateLimitedMetric = await webhookDeliveryRateLimitedTotal.get();
      expect(
        queuedMetric.values.some((v) => v.labels.tenant_id === "metrics-tenant-ok")
      ).toBe(false);
      expect(
        rateLimitedMetric.values.some((v) => v.labels.tenant_id === "metrics-tenant-ok")
      ).toBe(false);

      limiter.destroy();
    });

    it("increments webhook_delivery_queued_total and webhook_delivery_rate_limited_total exactly once per over-budget acquisition", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 1,
      });
      const tenant = "metrics-tenant-overflow";

      await limiter.acquire(tenant); // consumes the only token, no metric yet

      const pending = limiter.acquire(tenant); // over budget -> queued + metrics incremented synchronously
      await Promise.resolve();

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const rateLimitedMetric = await webhookDeliveryRateLimitedTotal.get();
      const queuedEntry = queuedMetric.values.find((v) => v.labels.tenant_id === tenant);
      const rateLimitedEntry = rateLimitedMetric.values.find(
        (v) => v.labels.tenant_id === tenant
      );

      expect(queuedEntry?.value).toBe(1);
      expect(rateLimitedEntry?.value).toBe(1);

      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      limiter.destroy();
    });

    it("uses separate metric label values per tenant", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 1,
      });

      await limiter.acquire("tenant-x");
      const p1 = limiter.acquire("tenant-x"); // over budget

      await limiter.acquire("tenant-y");
      const p2 = limiter.acquire("tenant-y"); // over budget

      await Promise.resolve();

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const xEntry = queuedMetric.values.find((v) => v.labels.tenant_id === "tenant-x");
      const yEntry = queuedMetric.values.find((v) => v.labels.tenant_id === "tenant-y");
      expect(xEntry?.value).toBe(1);
      expect(yEntry?.value).toBe(1);

      await vi.advanceTimersByTimeAsync(1100);
      await Promise.all([p1, p2]);
      limiter.destroy();
    });
  });
});
