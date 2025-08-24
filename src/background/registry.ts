import { logger, LogCategory } from '../lib/logger';
import { TabIdentity } from '../lib/identity';
import { cleanupManager } from '../lib/cleanup-manager';
import { TIMING } from '../lib/constants';

export interface RegistryEntry {
  tabId: number;
  windowId: number;
  appId: string;
  versionId: string;
  type: 'editor' | 'preview';
  hostname: string;
  url: string;
  updatedAt: number;
}

export class GroupRegistry {
  private tabsByIdentity = new Map<number, Map<string, Map<string, Set<number>>>>();
  private tabIndex = new Map<number, RegistryEntry>();

  /**
   * Add or update a tab's identity in the registry
   */
  setTabIdentity(tabId: number, windowId: number, identity: TabIdentity, url: string): void {
    const { appId, versionId } = identity;
    
    // Remove from old location if it exists
    this.removeTab(tabId);
    
    // Create nested structure if needed
    if (!this.tabsByIdentity.has(windowId)) {
      this.tabsByIdentity.set(windowId, new Map());
    }
    const windowMap = this.tabsByIdentity.get(windowId)!;
    
    if (!windowMap.has(appId)) {
      windowMap.set(appId, new Map());
    }
    const appMap = windowMap.get(appId)!;
    
    if (!appMap.has(versionId)) {
      appMap.set(versionId, new Set());
    }
    const versionSet = appMap.get(versionId)!;
    
    // Add tab to the set
    versionSet.add(tabId);
    
    // Update tab index
    this.tabIndex.set(tabId, {
      tabId,
      windowId,
      appId,
      versionId,
      type: identity.type,
      hostname: identity.hostname,
      url,
      updatedAt: Date.now()
    });
    
    logger.debug(LogCategory.TAB, 'Registry: Tab identity set', {
      tabId,
      windowId,
      appId,
      versionId,
      type: identity.type
    });
  }

  /**
   * Remove a tab from the registry
   */
  removeTab(tabId: number): void {
    const entry = this.tabIndex.get(tabId);
    if (!entry) {
      return; // Tab not in registry
    }
    
    const { windowId, appId, versionId } = entry;
    
    // Remove from nested structure
    const windowMap = this.tabsByIdentity.get(windowId);
    if (windowMap) {
      const appMap = windowMap.get(appId);
      if (appMap) {
        const versionSet = appMap.get(versionId);
        if (versionSet) {
          versionSet.delete(tabId);
          
          // Cleanup empty containers
          if (versionSet.size === 0) {
            appMap.delete(versionId);
            if (appMap.size === 0) {
              windowMap.delete(appId);
              if (windowMap.size === 0) {
                this.tabsByIdentity.delete(windowId);
              }
            }
          }
        }
      }
    }
    
    // Remove from tab index
    this.tabIndex.delete(tabId);
    
    logger.debug(LogCategory.TAB, 'Registry: Tab removed', {
      tabId,
      windowId,
      appId,
      versionId
    });
  }

  /**
   * Get a tab's identity
   */
  getIdentity(tabId: number): RegistryEntry | null {
    return this.tabIndex.get(tabId) || null;
  }

  /**
   * Get all tabs for a specific identity
   */
  getTabs(windowId: number, appId: string, versionId: string): Set<number> {
    return this.tabsByIdentity.get(windowId)?.get(appId)?.get(versionId) || new Set();
  }

  /**
   * Get all tabs in a window
   */
  getWindowTabs(windowId: number): RegistryEntry[] {
    const result: RegistryEntry[] = [];
    for (const [, entry] of this.tabIndex) {
      if (entry.windowId === windowId) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Get all unique apps in a window
   */
  getWindowApps(windowId: number): Set<string> {
    const apps = new Set<string>();
    const windowMap = this.tabsByIdentity.get(windowId);
    if (windowMap) {
      for (const appId of windowMap.keys()) {
        apps.add(appId);
      }
    }
    return apps;
  }

  /**
   * Clear all data (for testing/restart)
   */
  clear(): void {
    this.tabsByIdentity.clear();
    this.tabIndex.clear();
    logger.debug(LogCategory.TAB, 'Registry: Cleared all data');
  }

  /**
   * Get registry statistics for debugging
   */
  getStats(): {
    totalTabs: number;
    totalWindows: number;
    totalApps: number;
    tabsByWindow: { [windowId: number]: number };
  } {
    const tabsByWindow: { [windowId: number]: number } = {};
    const allApps = new Set<string>();
    
    for (const [windowId, windowMap] of this.tabsByIdentity) {
      let windowTabCount = 0;
      for (const [appId, appMap] of windowMap) {
        allApps.add(appId);
        for (const versionSet of appMap.values()) {
          windowTabCount += versionSet.size;
        }
      }
      tabsByWindow[windowId] = windowTabCount;
    }
    
    return {
      totalTabs: this.tabIndex.size,
      totalWindows: this.tabsByIdentity.size,
      totalApps: allApps.size,
      tabsByWindow
    };
  }

  /**
   * Dump registry contents for debugging
   */
  dumpRegistry(): void {
    // Safe no-op in production
  }

  /**
   * Get registry structure for debugging
   */
  private getRegistryStructure(): Record<string, unknown> {
    const structure: Record<string, unknown> = {};
    
    for (const [windowId, windowMap] of this.tabsByIdentity) {
      structure[windowId] = {};
      for (const [appId, appMap] of windowMap) {
        (structure[windowId] as Record<string, unknown>)[appId] = {};
        for (const [versionId, versionSet] of appMap) {
          ((structure[windowId] as Record<string, unknown>)[appId] as Record<string, unknown>)[versionId] = Array.from(versionSet);
        }
      }
    }
    
    return structure;
  }
}

/**
 * Last-active cache for version to app mapping
 * TTL: 30 minutes
 */
export class LastActiveCache {
  private cache = new Map<string, { appId: string; timestamp: number }>();
  private readonly TTL = TIMING.LAST_ACTIVE_TTL;

  /**
   * Set/update last-active entry for a version
   */
  set(versionId: string, appId: string): void {
    this.cache.set(versionId, {
      appId,
      timestamp: Date.now()
    });
    
    logger.debug(LogCategory.TAB, 'LastActive: Set', { versionId, appId });
  }

  /**
   * Get last-active app for a version (if not expired)
   */
  get(versionId: string): string | null {
    const entry = this.cache.get(versionId);
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(versionId);
      logger.debug(LogCategory.TAB, 'LastActive: Expired', { versionId });
      return null;
    }
    
    return entry.appId;
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [versionId, entry] of this.cache) {
      if (now - entry.timestamp > this.TTL) {
        this.cache.delete(versionId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(LogCategory.TAB, 'LastActive: Cleanup', { entriesRemoved: cleaned });
    }
  }

  /**
   * Get all non-expired entries for debugging
   */
  getAll(): Record<string, { appId: string; ageMinutes: number }> {
    const result: Record<string, { appId: string; ageMinutes: number }> = {};
    const now = Date.now();
    
    for (const [versionId, entry] of this.cache) {
      const ageMinutes = (now - entry.timestamp) / (60 * 1000);
      if (ageMinutes <= 30) { // Only non-expired entries
        result[versionId] = {
          appId: entry.appId,
          ageMinutes: Math.round(ageMinutes * 10) / 10 // Round to 1 decimal
        };
      }
    }
    
    return result;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    logger.debug(LogCategory.TAB, 'LastActive: Cleared all entries');
  }
}

// Singleton instances
export const groupRegistry = new GroupRegistry();
export const lastActiveCache = new LastActiveCache();

cleanupManager.addInterval(() => {
  lastActiveCache.cleanup();
}, TIMING.CLEANUP_INTERVAL);