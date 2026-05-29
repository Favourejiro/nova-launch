import { StellarReadCache, StellarCacheKeyBuilder } from './stellar-read-cache';

let globalCache: StellarReadCache | null = null;

/**
 * Initialize global cache instance.
 */
export function initializeStellarCache(ttlMs: number = 30000): StellarReadCache {
  globalCache = new StellarReadCache(ttlMs);
  return globalCache;
}

/**
 * Get global cache instance.
 */
export function getStellarCache(): StellarReadCache {
  if (!globalCache) {
    globalCache = new StellarReadCache();
  }
  return globalCache;
}

/**
 * Decorator for caching read queries.
 * Usage: @CacheStellarRead('tokenInfo', { ttl: 30000, fresh: false })
 */
export function CacheStellarRead(
  queryType: 'tokenInfo' | 'account' | 'factoryState' | 'transaction' | 'contractState',
  options?: { ttl?: number; fresh?: boolean }
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache = getStellarCache();
      const { ttl, fresh = false } = options || {};

      // Skip cache if fresh read requested
      if (fresh) {
        return originalMethod.apply(this, args);
      }

      // Build cache key based on query type and arguments
      let cacheKey: string;
      switch (queryType) {
        case 'tokenInfo':
          cacheKey = StellarCacheKeyBuilder.tokenInfo(args[0]);
          break;
        case 'account':
          cacheKey = StellarCacheKeyBuilder.account(args[0]);
          break;
        case 'factoryState':
          cacheKey = StellarCacheKeyBuilder.factoryState();
          break;
        case 'transaction':
          cacheKey = StellarCacheKeyBuilder.transaction(args[0]);
          break;
        case 'contractState':
          cacheKey = StellarCacheKeyBuilder.contractState(args[0], args[1]);
          break;
        default:
          cacheKey = `${queryType}:${JSON.stringify(args)}`;
      }

      // Check cache
      const cached = cache.get(cacheKey);
      if (cached !== null) {
        return cached;
      }

      // Execute original method
      const result = await originalMethod.apply(this, args);

      // Cache result
      cache.set(cacheKey, result, ttl);

      return result;
    };

    return descriptor;
  };
}

/**
 * Decorator for invalidating cache on writes.
 * Usage: @InvalidateStellarCache('tokenInfo', 0)
 */
export function InvalidateStellarCache(
  queryType: 'tokenInfo' | 'account' | 'factoryState' | 'all',
  addressArgIndex: number = 0
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await originalMethod.apply(this, args);
      const cache = getStellarCache();

      // Invalidate cache after write
      if (queryType === 'all') {
        cache.clear();
      } else {
        const address = args[addressArgIndex];
        if (address) {
          cache.invalidateByAddress(address);
        }
      }

      return result;
    };

    return descriptor;
  };
}
