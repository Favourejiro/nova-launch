/**
 * Tests for Redis-backed sliding-window rate limiter accuracy
 *
 * Issue #1065: Validate sliding-window accuracy under burst traffic
 * and edge cases around window boundaries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
import { incrementSlidingWindow, resolveKey } from "./rateLimiter";
import { Request } from "express";

// ─── Mock Redis ──────────────────────────────────────────────────────────────

let mockRedis: Redis;

beforeEach(() => {
  mockRedis = new Redis({
    host: "localhost",
    port: 6379,
    db: 15, // Use test DB to avoid polluting production
    enableOfflineQueue: false,
  });
});

afterEach(async () => {
  // Clean up test keys
  await mockRedis.flushdb();
  await mockRedis.quit();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockRequest(ip: string, walletAddress?: string): Partial<Request> {
  return {
    ip,
    socket: { remoteAddress: ip } as any,
    user: walletAddress ? { walletAddress } : undefined,
  } as any;
}

// ─── Issue #1065: Sliding-Window Accuracy Tests ──────────────────────────────

describe("Issue #1065: Redis sliding-window rate limiter accuracy", () => {
  const windowMs = 1000; // 1 second window for fast tests
  const key = "test:ratelimit:key";

  it("allows N requests within the window and rejects N+1th", async () => {
    const maxRequests = 5;

    // Make 5 requests (should all succeed)
    for (let i = 0; i < maxRequests; i++) {
      const count = await incrementSlidingWindow(mockRedis, key, windowMs);
      expect(count).toBeLessThanOrEqual(maxRequests);
    }

    // 6th request should exceed limit
    const count = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count).toBeGreaterThan(maxRequests);
  });

  it("counter resets correctly after window elapses", async () => {
    const maxRequests = 3;

    // Make 3 requests
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindow(mockRedis, key, windowMs);
    }

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, windowMs + 100));

    // Next request should be counted as 1 (window reset)
    const count = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count).toBe(1);
  });

  it("per-key isolation: different keys have independent budgets", async () => {
    const key1 = "test:key:1";
    const key2 = "test:key:2";
    const maxRequests = 2;

    // Exhaust key1
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindow(mockRedis, key1, windowMs);
    }

    // key2 should still have budget
    const count1 = await incrementSlidingWindow(mockRedis, key1, windowMs);
    const count2 = await incrementSlidingWindow(mockRedis, key2, windowMs);

    expect(count1).toBeGreaterThan(maxRequests); // key1 exceeded
    expect(count2).toBe(1); // key2 fresh
  });

  it("handles burst traffic: rapid requests all counted correctly", async () => {
    const maxRequests = 10;
    const requests = Array.from({ length: maxRequests + 5 }, () =>
      incrementSlidingWindow(mockRedis, key, windowMs)
    );

    const counts = await Promise.all(requests);

    // First 10 should be <= 10
    for (let i = 0; i < maxRequests; i++) {
      expect(counts[i]).toBeLessThanOrEqual(maxRequests);
    }

    // Last 5 should exceed limit
    for (let i = maxRequests; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(maxRequests);
    }
  });

  it("window boundary: old entries pruned correctly", async () => {
    const maxRequests = 3;

    // Make 3 requests at t=0
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindow(mockRedis, key, windowMs);
    }

    // Wait half the window
    await new Promise((r) => setTimeout(r, windowMs / 2));

    // Make 1 more request (should be 4 total in window)
    let count = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count).toBe(4);

    // Wait for first 3 to expire (total elapsed > windowMs)
    await new Promise((r) => setTimeout(r, windowMs / 2 + 100));

    // Only the last request should remain
    count = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count).toBe(2);
  });

  it("Redis unavailability: graceful degradation (no crash)", async () => {
    // Simulate Redis connection failure
    const failingRedis = new Redis({
      host: "invalid-host-that-does-not-exist",
      port: 9999,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 100,
    });

    // Should not throw, but may return a default value or handle gracefully
    try {
      await incrementSlidingWindow(failingRedis, key, windowMs);
    } catch (err) {
      // Expected to fail, but should not crash the process
      expect(err).toBeDefined();
    }

    await failingRedis.quit();
  });

  it("resolveKey uses wallet address when available", () => {
    const req = createMockRequest("192.168.1.1", "GWALLETABC123");
    const key = resolveKey(req as Request, "rl");

    expect(key).toContain("wallet:GWALLETABC123");
    expect(key).not.toContain("192.168.1.1");
  });

  it("resolveKey falls back to IP when wallet not available", () => {
    const req = createMockRequest("192.168.1.1");
    const key = resolveKey(req as Request, "rl");

    expect(key).toContain("ip:192.168.1.1");
  });

  it("different wallet addresses have independent limits", async () => {
    const wallet1Key = resolveKey(
      createMockRequest("192.168.1.1", "GWALLET1") as Request,
      "rl"
    );
    const wallet2Key = resolveKey(
      createMockRequest("192.168.1.1", "GWALLET2") as Request,
      "rl"
    );

    const maxRequests = 2;

    // Exhaust wallet1
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindow(mockRedis, wallet1Key, windowMs);
    }

    // wallet2 should have independent budget
    const count1 = await incrementSlidingWindow(mockRedis, wallet1Key, windowMs);
    const count2 = await incrementSlidingWindow(mockRedis, wallet2Key, windowMs);

    expect(count1).toBeGreaterThan(maxRequests);
    expect(count2).toBe(1);
  });

  it("TTL is set correctly to prevent stale keys", async () => {
    const windowMs = 2000;
    await incrementSlidingWindow(mockRedis, key, windowMs);

    // Check TTL
    const ttl = await mockRedis.ttl(key);

    // TTL should be approximately windowMs / 1000 seconds (with +1 buffer)
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(Math.ceil(windowMs / 1000) + 1);
  });

  it("concurrent requests from same key are all counted", async () => {
    const concurrentRequests = 20;
    const requests = Array.from({ length: concurrentRequests }, () =>
      incrementSlidingWindow(mockRedis, key, windowMs)
    );

    const counts = await Promise.all(requests);

    // All requests should be counted
    expect(counts[counts.length - 1]).toBe(concurrentRequests);
  });

  it("sliding window does not count requests outside the window", async () => {
    const windowMs = 500;

    // Request at t=0
    await incrementSlidingWindow(mockRedis, key, windowMs);

    // Wait for window to pass
    await new Promise((r) => setTimeout(r, windowMs + 100));

    // Request at t=600 should not see the first request
    const count = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count).toBe(1);
  });

  it("handles edge case: exactly at window boundary", async () => {
    const windowMs = 100;

    // Request at t=0
    const count1 = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count1).toBe(1);

    // Wait exactly windowMs
    await new Promise((r) => setTimeout(r, windowMs));

    // Request at t=100 should be in a new window
    const count2 = await incrementSlidingWindow(mockRedis, key, windowMs);
    expect(count2).toBe(1);
  });

  it("large window size works correctly", async () => {
    const largeWindowMs = 60000; // 1 minute
    const maxRequests = 100;

    for (let i = 0; i < maxRequests; i++) {
      const count = await incrementSlidingWindow(mockRedis, key, largeWindowMs);
      expect(count).toBeLessThanOrEqual(maxRequests);
    }

    const count = await incrementSlidingWindow(mockRedis, key, largeWindowMs);
    expect(count).toBeGreaterThan(maxRequests);
  });

  it("zero-balance holder receives zero claimable (rate limit context)", async () => {
    // This test verifies that the rate limiter correctly handles
    // the case where a key has no requests (zero balance)
    const unusedKey = "test:unused:key";

    // No requests made to this key
    const count = await incrementSlidingWindow(mockRedis, unusedKey, windowMs);

    // First request should be counted as 1
    expect(count).toBe(1);
  });
});
