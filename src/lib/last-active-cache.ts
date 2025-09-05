/**
 * M7: Last Active Cache for version-to-app mapping
 * Tracks most recent appId for each versionId to resolve custom domain ambiguity
 */

import { logger, LogCategory } from './logger';
import { isReservedVersion } from '../background/grouping';
import { CACHE } from './constants';

interface CacheEntry {
  appId: string;
  versionId: string;
  timestamp: number;
}

export class LastActiveCache {
  // In-memory cache for performance
  private cache = new Map<string, CacheEntry>();
  
  // Max entries to prevent memory bloat
  private readonly MAX_ENTRIES = 500;

  /**
   * Update the cache when a version is actively used
   */
  recordActivity(appId: string, versionId: string): void {
    // Skip test/live as they're not useful for custom domain mapping
    if (isReservedVersion(versionId)) {
      return;
    }

    const entry: CacheEntry = {
      appId,
      versionId,
      timestamp: Date.now()
    };

    this.cache.set(versionId, entry);
    
    // Trim cache if too large
    if (this.cache.size > this.MAX_ENTRIES) {
      this.trimCache();
    }

    logger.debug(LogCategory.CUSTOM_DOMAIN, 'Recorded version activity', { appId, versionId });
  }

  /**
   * Get the most recent appId for a versionId
   */
  getAppForVersion(versionId: string): string | null {
    const entry = this.cache.get(versionId);
    if (!entry) {
      logger.debug(LogCategory.CUSTOM_DOMAIN, 'No cached app for version', { versionId });
      return null;
    }

    logger.debug(LogCategory.CUSTOM_DOMAIN, 'Found cached app for version', { 
      versionId, 
      appId: entry.appId,
      ageMs: Date.now() - entry.timestamp
    });
    
    return entry.appId;
  }

  /**
   * Check if we have a confident mapping for a version
   * (recent activity within last hour)
   */
  hasConfidentMapping(versionId: string): boolean {
    const entry = this.cache.get(versionId);
    if (!entry) return false;

    const ageMs = Date.now() - entry.timestamp;
    const isRecent = ageMs < CACHE.CONFIDENT_MAPPING_TTL;
    
    return isRecent;
  }

  /**
   * Get cache stats for debugging
   */
  getStats(): { entries: number; versionIds: string[] } {
    return {
      entries: this.cache.size,
      versionIds: Array.from(this.cache.keys())
    };
  }

  /**
   * Trim cache by removing oldest entries
   */
  private trimCache(): void {
    // Sort by timestamp and keep most recent 80% of MAX_ENTRIES
    const entries = Array.from(this.cache.entries())
      .map(([versionId, entry]) => ({ cacheKey: versionId, ...entry }))
      .sort((a, b) => b.timestamp - a.timestamp);

    const keepCount = Math.floor(this.MAX_ENTRIES * 0.8);
    const toKeep = entries.slice(0, keepCount);

    this.cache.clear();
    for (const entry of toKeep) {
      this.cache.set(entry.cacheKey, {
        appId: entry.appId,
        versionId: entry.versionId,
        timestamp: entry.timestamp
      });
    }

    logger.debug(LogCategory.CUSTOM_DOMAIN, 'Trimmed cache', { 
      from: entries.length, 
      to: toKeep.length 
    });
  }

  /**
   * Clear the cache (for testing/debugging)
   */
  clear(): void {
    this.cache.clear();
    logger.debug(LogCategory.CUSTOM_DOMAIN, 'Cache cleared');
  }
}

// Singleton instance
export const lastActiveCache = new LastActiveCache();