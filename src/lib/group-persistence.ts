import { logger, LogCategory } from './logger';

export interface GroupMapping {
  appId: string;
  versionId: string;
  windowId: number;
  lastSeen: number;
}

interface GroupMappingsStorage {
  [groupId: string]: GroupMapping;
}

/**
 * Handles persistence of group identity mappings to survive service worker suspension
 * Key insight: Chrome groups persist across suspension, but our in-memory registry doesn't
 */
export class GroupPersistence {
  private readonly STORAGE_KEY = 'groupMappings';
  private readonly MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  
  /**
   * Store a group's identity mapping
   */
  async storeGroupMapping(groupId: number, appId: string, versionId: string, windowId: number): Promise<void> {
    try {
      const mappings = await this.getAllMappings();
      const groupKey = groupId.toString();
      
      mappings[groupKey] = {
        appId,
        versionId,
        windowId,
        lastSeen: Date.now()
      };
      
      await chrome.storage.local.set({ [this.STORAGE_KEY]: mappings });
      
      logger.debug(LogCategory.GROUP, 'Group mapping stored', {
        groupId,
        appId,
        versionId,
        windowId
      });
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to store group mapping', {
        groupId,
        appId,
        versionId,
        error
      });
    }
  }
  
  /**
   * Get a specific group's mapping
   */
  async getGroupMapping(groupId: number): Promise<GroupMapping | null> {
    try {
      const mappings = await this.getAllMappings();
      return mappings[groupId.toString()] || null;
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to get group mapping', {
        groupId,
        error
      });
      return null;
    }
  }
  
  /**
   * Get all stored group mappings
   */
  async getAllMappings(): Promise<GroupMappingsStorage> {
    try {
      const result = await chrome.storage.local.get(this.STORAGE_KEY);
      return result[this.STORAGE_KEY] || {};
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to get all group mappings', { error });
      return {};
    }
  }
  
  /**
   * Remove a group mapping (when group is deleted)
   */
  async removeGroupMapping(groupId: number): Promise<void> {
    try {
      const mappings = await this.getAllMappings();
      const groupKey = groupId.toString();
      
      if (mappings[groupKey]) {
        delete mappings[groupKey];
        await chrome.storage.local.set({ [this.STORAGE_KEY]: mappings });
        
        logger.debug(LogCategory.GROUP, 'Group mapping removed', { groupId });
      }
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to remove group mapping', {
        groupId,
        error
      });
    }
  }
  
  /**
   * Clean up stale group mappings for groups that no longer exist
   * Called during initialization to maintain storage hygiene
   */
  async cleanupStaleGroups(): Promise<void> {
    try {
      const mappings = await this.getAllMappings();
      const allGroups = await chrome.tabGroups.query({});
      const existingGroupIds = new Set(allGroups.map(g => g.id.toString()));
      const now = Date.now();
      
      let cleanedCount = 0;
      const cleanedMappings: GroupMappingsStorage = {};
      
      for (const [groupIdStr, mapping] of Object.entries(mappings)) {
        // Remove if group doesn't exist OR is too old
        const isTooOld = (now - mapping.lastSeen) > this.MAX_AGE_MS;
        const groupExists = existingGroupIds.has(groupIdStr);
        
        if (groupExists && !isTooOld) {
          // Keep this mapping
          cleanedMappings[groupIdStr] = mapping;
        } else {
          // Remove this mapping
          cleanedCount++;
          logger.debug(LogCategory.GROUP, 'Cleaned stale group mapping', {
            groupId: groupIdStr,
            reason: groupExists ? 'too old' : 'group deleted'
          });
        }
      }
      
      if (cleanedCount > 0) {
        await chrome.storage.local.set({ [this.STORAGE_KEY]: cleanedMappings });
        logger.info(LogCategory.GROUP, 'Group mappings cleanup complete', {
          removed: cleanedCount,
          remaining: Object.keys(cleanedMappings).length
        });
      }
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to cleanup stale group mappings', { error });
    }
  }
  
  /**
   * Find groups with a specific identity
   * Returns array of group IDs that match the identity
   */
  async findGroupsForIdentity(appId: string, versionId: string, windowId?: number): Promise<number[]> {
    try {
      const mappings = await this.getAllMappings();
      const matchingGroups: number[] = [];
      
      for (const [groupIdStr, mapping] of Object.entries(mappings)) {
        const matches = mapping.appId === appId && 
                       mapping.versionId === versionId &&
                       (!windowId || mapping.windowId === windowId);
        
        if (matches) {
          matchingGroups.push(parseInt(groupIdStr));
        }
      }
      
      return matchingGroups;
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to find groups for identity', {
        appId,
        versionId,
        error
      });
      return [];
    }
  }
  
  /**
   * Update the lastSeen timestamp for a group
   */
  async touchGroupMapping(groupId: number): Promise<void> {
    try {
      const mappings = await this.getAllMappings();
      const groupKey = groupId.toString();
      
      if (mappings[groupKey]) {
        mappings[groupKey].lastSeen = Date.now();
        await chrome.storage.local.set({ [this.STORAGE_KEY]: mappings });
      }
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to touch group mapping', {
        groupId,
        error
      });
    }
  }
}

// Singleton instance
export const groupPersistence = new GroupPersistence();