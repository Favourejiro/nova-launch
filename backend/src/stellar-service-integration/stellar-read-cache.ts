import { Logger } from '@nestjs/common';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory cache for idempotent Stellar read queries.
 * Reduces RPC load and latency with configurable TTL.
 * Supports invalidation on writes to the same account/contract.
 */
export class StellarReadCache {
  private readonly cache = new Map<string, CacheEntry<any>>();
  private readonly logger = new Logger(StellarReadCache.name);
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 30000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Get cached value if not expired.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value as T;
  }

  /**
   * Set cache value with optional custom TTL.
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Invalidate cache entry.
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all cache entries for an account/contract.
   * Matches keys starting with the address.
   */
  invalidateByAddress(address: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(address)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Cache key builder for Stellar queries.
 */
export class StellarCacheKeyBuilder {
  static tokenInfo(address: string): string {
    return `token:${address}`;
  }

  static account(address: string): string {
    return `account:${address}`;
  }

  static factoryState(): string {
    return 'factory:state';
  }

  static transaction(txHash: string): string {
    return `tx:${txHash}`;
  }

  static contractState(contractId: string, key: string): string {
    return `contract:${contractId}:${key}`;
  }
}
