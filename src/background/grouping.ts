import { logger, LogCategory, getErrorMessage } from '../lib/logger';
import { storage } from '../lib/storage';
import { groupRegistry } from './registry';

const RESERVED_COLORS = {
  'live': 'green' as chrome.tabGroups.ColorEnum,
  'test': 'blue' as chrome.tabGroups.ColorEnum,
} as const;

interface ManualHold {
  tabId: number;
  appId: string;
  versionId: string;
  heldAt: number;
}

export interface GroupMapping {
  groupId: number;
  windowId: number;
  appId: string;
  versionId: string;
  createdAt: number;
}

class GroupingEngine {
  private manualHolds = new Map<number, ManualHold>(); // tabId → hold
  private groupMappings = new Map<number, GroupMapping>(); // groupId → mapping
  private internalOps = new Set<string>(); // Track our own operations to avoid feedback loops
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Plan and execute grouping for all tabs in the registry
   */
  async planAndExecuteGrouping(reason: string): Promise<void> {
    logger.info(LogCategory.GROUP, `Planning grouping: ${reason}`);
    
    // Check if grouping is enabled
    const isEnabled = await storage.isGroupingEnabled();
    if (!isEnabled) {
      return;
    }
    
    try {
      const stats = groupRegistry.getStats();
      if (stats.totalTabs === 0) {
        return;
      }

      const buckets = await this.bucketTabsByIdentity();
      logger.info(LogCategory.GROUP, 'Processing', { 
        bucketCount: buckets.length
      });

      for (const bucket of buckets) {
        await this.processTabBucket(bucket);
      }

      // Clean up empty groups
      await this.cleanupEmptyGroups();
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Grouping execution failed', { 
        reason, 
        error: getErrorMessage(error)
      });
    }
  }

  /**
   * Bucket tabs by their identity (windowId, appId, versionId)
   */
  private async bucketTabsByIdentity(): Promise<TabBucket[]> {
    const buckets: TabBucket[] = [];
    const stats = groupRegistry.getStats();

    // Iterate through all windows
    for (const [windowId] of Object.entries(stats.tabsByWindow)) {
      const windowTabs = groupRegistry.getWindowTabs(parseInt(windowId));
      
      // Group tabs by (appId, versionId) within this window
      const appVersionMap = new Map<string, chrome.tabs.Tab[]>();
      
      for (const entry of windowTabs) {
        const key = `${entry.appId}:${entry.versionId}`;
        if (!appVersionMap.has(key)) {
          appVersionMap.set(key, []);
        }
        
        // Get actual tab object
        try {
          const tab = await chrome.tabs.get(entry.tabId);
          if (tab && !tab.pinned && !this.hasManualHold(entry.tabId, entry.appId, entry.versionId)) {
            appVersionMap.get(key)!.push(tab);
          }
        } catch (error) {
        }
      }

      // Create buckets for this window
      for (const [key, tabs] of appVersionMap) {
        if (tabs.length > 0) {
          const [appId, versionId] = key.split(':');
          buckets.push({
            windowId: parseInt(windowId),
            appId,
            versionId,
            tabs,
            key
          });
        }
      }
    }

    return buckets;
  }

  /**
   * Process a single tab bucket - group tabs and set title/color
   */
  private async processTabBucket(bucket: TabBucket): Promise<void> {

    try {
      // Find or create group for this identity
      const groupId = await this.findOrCreateGroup(bucket);
      
      if (groupId === null) {
        logger.error(LogCategory.GROUP, 'Failed to find or create group');
        return;
      }

      // Move additional tabs into the group (first tab already in group from creation)
      if (bucket.tabs.length > 1) {
        await this.moveTabsToGroup(bucket.tabs, groupId);
      }

      // Update group title and color
      await this.updateGroupProperties(groupId, bucket);

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to process bucket', {
        bucket: bucket.key,
        error
      });
    }
  }

  /**
   * Find existing group or create new one for this identity
   */
  private async findOrCreateGroup(bucket: TabBucket): Promise<number | null> {
    logger.info(LogCategory.GROUP, 'Finding or creating group', {
      key: bucket.key,
      tabCount: bucket.tabs.length,
      tabIds: bucket.tabs.map(t => t.id),
      appId: bucket.appId,
      versionId: bucket.versionId
    });

    // Look for existing group with this identity
    for (const [groupId, mapping] of this.groupMappings) {
      if (mapping.windowId === bucket.windowId && 
          mapping.appId === bucket.appId && 
          mapping.versionId === bucket.versionId) {
        return groupId;
      }
    }

    // Create new group
    try {
      this.markInternalOp(`create-group-${Date.now()}`);
      
      const groupId = await this.retryTabOperation(() => chrome.tabs.group({
        tabIds: [bucket.tabs[0].id!],
      }));

      // Store mapping
      this.groupMappings.set(groupId, {
        groupId: groupId,
        windowId: bucket.windowId,
        appId: bucket.appId,
        versionId: bucket.versionId,
        createdAt: Date.now()
      });

      // Track that we created this group
      await storage.addExtensionGroup(groupId);

      logger.info(LogCategory.GROUP, 'Created new group', { 
        groupId: groupId, 
        identity: bucket.key 
      });

      return groupId;

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to create group', { 
        bucket: bucket.key, 
        error 
      });
      return null;
    }
  }

  /**
   * Move tabs into their designated group
   */
  private async moveTabsToGroup(tabs: chrome.tabs.Tab[], groupId: number): Promise<void> {
    const tabsToMove = tabs.slice(1); // Skip first tab (already in group)
    
    if (tabsToMove.length === 0) {
      return;
    }

    try {
      this.markInternalOp(`move-tabs-${Date.now()}`);
      
      await this.retryTabOperation(() => chrome.tabs.group({
        tabIds: tabsToMove.map(tab => tab.id!),
        groupId: groupId
      }));

    } catch (error) {
      this.logGroupError('Failed to move tabs to group', error, {
        groupId,
        tabCount: tabsToMove.length
      });
    }
  }

  /**
   * Update group title and color based on per-window naming policy
   */
  private async updateGroupProperties(groupId: number, bucket: TabBucket): Promise<void> {
    try {
      // Check if group still exists
      const group = await this.checkGroupExists(groupId, bucket.key);
      if (!group) {
        return; // Group was deleted, mapping cleaned up by checkGroupExists
      }
      
      // Compute title and get stored color
      const title = await this.computeGroupTitle(bucket);
      const branch = await storage.getBranch(bucket.appId, bucket.versionId);
      let color = branch?.color || null;
      
      // Capture Chrome's assigned color if no stored color
      if (branch && !color && group.color) {
        await this.persistBranchColor(bucket.appId, bucket.versionId, group.color);
        color = group.color;
        
        logger.info(LogCategory.GROUP, 'Captured and stored Chrome-assigned color', {
          appId: bucket.appId,
          versionId: bucket.versionId,
          color: group.color
        });
      }
      
      // Prepare updates
      const updates = this.prepareGroupUpdates(group, title, color);
      
      // Apply updates if needed
      if (Object.keys(updates).length > 0) {
        await this.applyGroupUpdates(groupId, updates);
      }

    } catch (error) {
      this.logGroupError('Failed to update group properties', error, {
        groupId,
        bucket: bucket.key
      });
    }
  }

  /**
   * Prepare group updates by comparing current state with desired state
   */
  private prepareGroupUpdates(
    group: chrome.tabGroups.TabGroup, 
    title: string, 
    color: chrome.tabGroups.ColorEnum | null
  ): chrome.tabGroups.UpdateProperties {
    const updates: chrome.tabGroups.UpdateProperties = {};
    
    if (group.title !== title) {
      updates.title = title;
    }
    
    if (color && group.color !== color) {
      updates.color = color;
    }
    
    return updates;
  }

  /**
   * Apply group updates with retry logic
   */
  private async applyGroupUpdates(
    groupId: number, 
    updates: chrome.tabGroups.UpdateProperties
  ): Promise<void> {
    this.markInternalOp(`update-group-${groupId}`);
    await this.retryTabOperation(() => chrome.tabGroups.update(groupId, updates));
  }

  private logGroupError(message: string, error: unknown, context: Record<string, any>): void {
    logger.error(LogCategory.GROUP, message, { error: String(error), ...context });
  }

  /**
   * Compute group title based on per-window naming policy
   */
  private async computeGroupTitle(bucket: TabBucket): Promise<string> {
    // Get version label with priority:
    // 1. displayName (user override)
    // 2. Test/Live for those specific versions
    // 3. name (scraped branch name)
    // 4. versionId (fallback)
    let versionLabel = bucket.versionId;
    
    try {
      const branch = await storage.getBranch(bucket.appId, bucket.versionId);
      
      if (branch?.displayName) {
        // Always use user's displayName verbatim - don't add appId suffix
        return branch.displayName;
      } else if (bucket.versionId === 'test') {
        versionLabel = 'Test';
      } else if (bucket.versionId === 'live') {
        versionLabel = 'Live';
      } else if (branch?.name) {
        // Use scraped branch name
        versionLabel = branch.name;
      }
    } catch (error) {
      // Continue with fallback
    }

    // Determine if window is single-app or multi-app
    const isMultiApp = await this.isMultiAppWindow(bucket.windowId);
    
    // Apply per-window naming policy
    const finalTitle = isMultiApp ? `${versionLabel} | ${bucket.appId}` : versionLabel;
    
    return finalTitle;
  }

  /**
   * Determine if a window contains multiple apps
   */
  private async isMultiAppWindow(windowId: number): Promise<boolean> {
    const apps = groupRegistry.getWindowApps(windowId);
    return apps.size > 1;
  }

  /**
   * Get reserved color for version (test=blue, live=green)
   */
  private getReservedColor(versionId: string): chrome.tabGroups.ColorEnum | null {
    return RESERVED_COLORS[versionId as keyof typeof RESERVED_COLORS] || null;
  }

  // Using Chrome's automatic color assignment for simplicity

  /**
   * Assign and persist color for new branch (public method for service worker)
   */
  async assignColorForNewBranch(appId: string, versionId: string): Promise<chrome.tabGroups.ColorEnum | null> {
    try {
      // Check if branch already has a color (shouldn't happen, but safety check)
      const existingBranch = await storage.getBranch(appId, versionId);
      if (existingBranch?.color) {
        return existingBranch.color;
      }

      // Handle reserved colors (test, live) - assign immediately
      const reservedColor = this.getReservedColor(versionId);
      if (reservedColor) {
        await this.persistBranchColor(appId, versionId, reservedColor);
        return reservedColor;
      }

      // For regular branches: Let Chrome assign the color, capture it later
      return null;

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to assign color for new branch', {
        appId,
        versionId,
        error
      });
      return null;
    }
  }

  /**
   * Persist branch color to storage
   */
  private async persistBranchColor(appId: string, versionId: string, color: chrome.tabGroups.ColorEnum): Promise<void> {
    try {
      let branch = await storage.getBranch(appId, versionId);
      if (!branch) {
        branch = { appId, versionId, updatedAt: Date.now() };
      }
      
      branch.color = color;
      branch.updatedAt = Date.now();
      
      await storage.setBranch(appId, versionId, branch);
      
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to persist branch color', { 
        appId, 
        versionId, 
        color, 
        error 
      });
    }
  }

  /**
   * Clean up empty groups that we created
   */
  private async cleanupEmptyGroups(): Promise<void> {
    const groupsToDelete: number[] = [];

    for (const [groupId, mapping] of this.groupMappings) {
      try {
        // Only clean up groups we created
        const isOurs = await storage.isExtensionGroup(groupId);
        if (!isOurs) {
          continue;
        }
        
        // Query tabs in this group
        const tabs = await chrome.tabs.query({ groupId: groupId });
        
        if (tabs.length === 0) {
          groupsToDelete.push(groupId);
        }
        
      } catch (error) {
        // Group no longer exists
        groupsToDelete.push(groupId);
      }
    }

    // Remove empty groups from mapping
    for (const groupId of groupsToDelete) {
      this.groupMappings.delete(groupId);
    }

    if (groupsToDelete.length > 0) {
      logger.info(LogCategory.GROUP, 'Cleaned up empty groups', { 
        count: groupsToDelete.length 
      });
    }
  }

  /**
   * Handle user manually moving a tab - create hold
   */
  handleManualTabMove(tabId: number, appId: string, versionId: string): void {
    this.manualHolds.set(tabId, {
      tabId,
      appId,
      versionId,
      heldAt: Date.now()
    });
  }

  /**
   * Handle tab identity change - release hold if version changed
   */
  handleTabIdentityChange(tabId: number, newAppId: string, newVersionId: string): void {
    const hold = this.manualHolds.get(tabId);
    if (hold && (hold.appId !== newAppId || hold.versionId !== newVersionId)) {
      this.manualHolds.delete(tabId);
    }
  }

  /**
   * Handle user renaming a group - store as displayName only if it's truly a user rename
   */
  async handleUserGroupRename(groupId: number, newTitle: string): Promise<void> {
    const mapping = this.groupMappings.get(groupId);
    if (!mapping) {
      return;
    }

    try {
      // Check if this title matches what we would generate automatically
      const bucket = {
        windowId: mapping.windowId,
        appId: mapping.appId,
        versionId: mapping.versionId,
        tabs: [], // Not needed for title computation
        key: `${mapping.appId}:${mapping.versionId}`
      };
      
      // Compute what the automatic title would be (without displayName)
      const automaticTitle = await this.computeAutomaticTitle(bucket);
      
      // If the new title matches the automatic title, don't store it as displayName
      if (newTitle === automaticTitle) {
        return;
      }
      
      // This is a genuine user rename - store as displayName
      let branch = await storage.getBranch(mapping.appId, mapping.versionId);
      if (!branch) {
        branch = { 
          appId: mapping.appId, 
          versionId: mapping.versionId, 
          updatedAt: Date.now() 
        };
      }
      
      branch.displayName = newTitle;
      branch.updatedAt = Date.now();
      
      await storage.setBranch(mapping.appId, mapping.versionId, branch);
      
      logger.info(LogCategory.GROUP, 'Stored user group rename as displayName', {
        groupId,
        appId: mapping.appId,
        versionId: mapping.versionId,
        displayName: newTitle,
        automaticTitle
      });

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to store group rename', {
        groupId,
        newTitle,
        error
      });
    }
  }

  /**
   * Handle user changing a group color - persist to storage
   */
  async handleUserGroupColorChange(groupId: number, newColor: chrome.tabGroups.ColorEnum): Promise<void> {
    const mapping = this.groupMappings.get(groupId);
    if (!mapping) {
      return;
    }

    try {
      // Get current color before updating
      const currentBranch = await storage.getBranch(mapping.appId, mapping.versionId);
      const oldColor = currentBranch?.color;
      
      // Check if this is a reserved color that shouldn't be overridden
      const reservedColor = this.getReservedColor(mapping.versionId);
      if (reservedColor && newColor !== reservedColor) {
        logger.info(LogCategory.GROUP, 'User changed color for reserved version', {
          groupId,
          versionId: mapping.versionId,
          reservedColor,
          userColor: newColor,
          appId: mapping.appId
        });
      }

      // Always persist user color choice
      await this.persistBranchColor(mapping.appId, mapping.versionId, newColor);
      
      // Apply color to same-identity groups in all windows for consistency
      await this.refreshTitlesForIdentity(mapping.appId, mapping.versionId);
      
      logger.info(LogCategory.GROUP, 'User group color change persisted and applied across windows', {
        groupId,
        appId: mapping.appId,
        versionId: mapping.versionId,
        oldColor: oldColor || 'none',
        newColor
      });
      
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to persist group color change', {
        groupId,
        newColor,
        error
      });
    }
  }

  /**
   * Set Chrome tab group color for a specific tab's branch
   */
  async setBranchColor(tabId: number, color: chrome.tabGroups.ColorEnum): Promise<void> {
    try {
      // Get the tab and its identity
      const tab = await chrome.tabs.get(tabId);
      if (!tab.groupId || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        return;
      }

      // Get the mapping for this group
      const mapping = this.groupMappings.get(tab.groupId);
      if (!mapping) {
        return;
      }

      // Update the group color
      await chrome.tabGroups.update(tab.groupId, { color });
      
      // Persist the color for this branch
      await this.persistBranchColor(mapping.appId, mapping.versionId, color);
      
      // Apply color to same-identity groups in all windows for consistency
      await this.refreshTitlesForIdentity(mapping.appId, mapping.versionId);
      
      logger.info(LogCategory.GROUP, 'Branch color set successfully', {
        tabId,
        groupId: tab.groupId,
        appId: mapping.appId,
        versionId: mapping.versionId,
        color
      });
      
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to set branch color', {
        tabId,
        color,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }
  
  /**
   * Compute what the automatic title would be (ignoring displayName)
   */
  private async computeAutomaticTitle(bucket: TabBucket): Promise<string> {
    let versionLabel = bucket.versionId;
    
    try {
      const branch = await storage.getBranch(bucket.appId, bucket.versionId);
      
      // Use automatic title priority (ignore displayName):
      // 1. Test/Live for those specific versions
      // 2. name (scraped branch name)
      // 3. versionId (fallback)
      if (bucket.versionId === 'test') {
        versionLabel = 'Test';
      } else if (bucket.versionId === 'live') {
        versionLabel = 'Live';
      } else if (branch?.name) {
        versionLabel = branch.name;
      }
    } catch (error) {
      // Use versionId as fallback
    }
    
    // Apply per-window naming policy
    const isMultiApp = await this.isMultiAppWindow(bucket.windowId);
    return isMultiApp ? `${versionLabel} | ${bucket.appId}` : versionLabel;
  }

  /**
   * Handle group removal - clean up mapping and tracking
   */
  async handleGroupRemoval(groupId: number): Promise<void> {
    const mapping = this.groupMappings.get(groupId);
    if (mapping) {
      this.groupMappings.delete(groupId);
      
      // Remove from extension groups tracking
      await storage.removeExtensionGroup(groupId);
    }
  }

  /**
   * Check if tab has manual hold for current identity
   */
  private hasManualHold(tabId: number, appId: string, versionId: string): boolean {
    const hold = this.manualHolds.get(tabId);
    return hold !== undefined && hold.appId === appId && hold.versionId === versionId;
  }

  /**
   * Mark internal operation to avoid feedback loops
   */
  private markInternalOp(opId: string): void {
    this.internalOps.add(opId);
    // Auto-cleanup after 1 second
    setTimeout(() => {
      this.internalOps.delete(opId);
    }, 1000);
  }

  /**
   * Check if operation is internal
   */
  isInternalOp(opId: string): boolean {
    return this.internalOps.has(opId);
  }

  /**
   * Refresh titles for a specific identity without moving tabs
   * Used when branch names are scraped/updated
   */
  async refreshTitlesForIdentity(appId: string, versionId: string): Promise<void> {
    // Find all groups with this identity
    const groupsToUpdate: number[] = [];
    for (const [groupId, mapping] of this.groupMappings) {
      if (mapping.appId === appId && mapping.versionId === versionId) {
        groupsToUpdate.push(groupId);
      }
    }

    if (groupsToUpdate.length === 0) {
      return;
    }

    // Update each group's title
    for (const groupId of groupsToUpdate) {
      const mapping = this.groupMappings.get(groupId);
      if (!mapping) continue;

      // Get tabs in this group to determine title
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length === 0) continue;

      // Create a bucket for title computation
      const bucket: TabBucket = {
        windowId: mapping.windowId,
        appId: mapping.appId,
        versionId: mapping.versionId,
        tabs,
        key: `${mapping.windowId}:${mapping.appId}:${mapping.versionId}`
      };

      // Update group properties (title only, no color change)
      await this.updateGroupProperties(groupId, bucket);
    }
  }

  /**
   * Debounced planning - coalesce rapid events
   */
  debouncedPlan(reason: string, delayMs = 200): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.planAndExecuteGrouping(reason);
    }, delayMs);
  }

  /**
   * Startup recovery - rebuild group mappings from current tabs
   */
  async recoverGroupMappings(): Promise<void> {
    logger.info(LogCategory.GROUP, 'Starting group mapping recovery');
    
    try {
      // Clear existing mappings
      this.groupMappings.clear();
      
      // Get all tab groups
      const allGroups = await chrome.tabGroups.query({});
      
      // Get list of groups we created
      const ourGroups = await storage.getExtensionGroups();
      
      for (const group of allGroups) {
        // Only recover groups we created
        if (!ourGroups.includes(group.id)) {
          continue;
        }
        
        // Get tabs in this group
        const tabs = await chrome.tabs.query({ groupId: group.id });
        
        if (tabs.length === 0) {
          continue;
        }

        // Determine group identity by consensus of contained tabs
        const identities = new Map<string, number>(); // identity → count
        
        for (const tab of tabs) {
          if (tab.url) {
            const identity = groupRegistry.getIdentity(tab.id!);
            if (identity) {
              const key = `${identity.appId}:${identity.versionId}`;
              identities.set(key, (identities.get(key) || 0) + 1);
            }
          }
        }

        // Use majority identity for this group
        let maxCount = 0;
        let groupIdentity: string | null = null;
        
        for (const [identity, count] of identities) {
          if (count > maxCount) {
            maxCount = count;
            groupIdentity = identity;
          }
        }

        if (groupIdentity) {
          const [appId, versionId] = groupIdentity.split(':');
          this.groupMappings.set(group.id, {
            groupId: group.id,
            windowId: group.windowId,
            appId,
            versionId,
            createdAt: Date.now()
          });
        }
      }

      logger.info(LogCategory.GROUP, 'Group mapping recovery complete', {
        recoveredGroups: this.groupMappings.size
      });

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Group mapping recovery failed', {
        error: getErrorMessage(error),
        errorStack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * Get group mapping for a specific group ID
   * Used for validating tab group membership
   */
  getGroupMapping(groupId: number): GroupMapping | undefined {
    return this.groupMappings.get(groupId);
  }

  /**
   * Get current statistics for debugging
   */
  getStats() {
    return {
      groupMappings: this.groupMappings.size,
      manualHolds: this.manualHolds.size,
      internalOps: this.internalOps.size,
      debounceActive: this.debounceTimer !== null
    };
  }

  /**
   * Dump current state for debugging
   */
  dumpState(): void {
    // Safe no-op in production
  }

  /**
   * Check if a group exists and clean up mapping if it doesn't
   */
  private async checkGroupExists(groupId: number, bucketKey?: string): Promise<chrome.tabGroups.TabGroup | null> {
    try {
      return await chrome.tabGroups.get(groupId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (errorMsg.includes('No group with id') || errorMsg.includes('not found')) {
        // Clean up our mappings
        this.groupMappings.delete(groupId);
        await storage.removeExtensionGroup(groupId);
        return null;
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Retry tab operations with exponential backoff for Chrome API limitations
   */
  private async retryTabOperation<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if this is a Chrome API "tabs cannot be edited" error
        const isTabEditingRestriction = lastError.message.includes('cannot be edited right now') ||
                                       lastError.message.includes('user may be dragging');
        
        if (!isTabEditingRestriction || attempt === maxRetries) {
          // If it's not a tab editing restriction, or we've exhausted retries, throw immediately
          throw lastError;
        }
        
        // Calculate delay with exponential backoff + jitter
        const baseDelay = Math.pow(2, attempt) * 100; // 100ms, 200ms, 400ms
        const jitter = Math.random() * 50; // 0-50ms random jitter
        const delay = baseDelay + jitter;
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }
}

// Tab bucket for grouping
interface TabBucket {
  windowId: number;
  appId: string;
  versionId: string;
  tabs: chrome.tabs.Tab[];
  key: string; // "appId:versionId" for debugging
}

// Singleton instance
export const groupingEngine = new GroupingEngine();