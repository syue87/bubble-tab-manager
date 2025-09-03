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


class GroupingEngine {
  private manualHolds = new Map<number, ManualHold>(); // tabId → hold
  private internalOps = new Set<string>(); // Track our own operations to avoid feedback loops
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeIdentityChanges = new Set<number>(); // tabId → prevent contamination during moves

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
          if (tab && !tab.pinned && 
              !this.hasManualHold(entry.tabId, entry.appId, entry.versionId) &&
              !this.activeIdentityChanges.has(entry.tabId)) {
            appVersionMap.get(key)!.push(tab);
          }
        } catch {
          // Tab no longer exists, skip
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
    const existingGroupId = await this.findGroupByIdentity(bucket.windowId, bucket.appId, bucket.versionId);
    if (existingGroupId) {
      return existingGroupId;
    }

    // Create new group
    try {
      this.markInternalOp(`create-group-${Date.now()}`);
      
      const groupId = await this.retryTabOperation(() => chrome.tabs.group({
        tabIds: [bucket.tabs[0].id!],
      }));

      // Track that we created this group
      await storage.addExtensionGroup(groupId);

      // Assign reserved colors for test/live
      const reservedColor = this.getReservedColor(bucket.versionId);
      if (reservedColor) {
        await this.applyGroupUpdates(groupId, { color: reservedColor });
        await this.persistBranchColor(bucket.appId, bucket.versionId, reservedColor);
        logger.info(LogCategory.GROUP, 'Assigned reserved color to new group', {
          groupId,
          versionId: bucket.versionId,
          color: reservedColor
        });
      }

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
   * Move tabs into their designated group (bulk grouping)
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
      logger.error(LogCategory.GROUP, 'Failed to move tabs to group', {
        groupId,
        tabCount: tabsToMove.length,
        error: getErrorMessage(error)
      });
    }
  }

  /**
   * Move a single tab to a different group (identity changes)
   */
  private async moveSingleTabToGroup(tabId: number, targetGroupId: number): Promise<boolean> {
    try {
      this.markInternalOp(`move-single-tab-${Date.now()}`);
      
      await this.retryTabOperation(() => chrome.tabs.group({
        tabIds: [tabId],
        groupId: targetGroupId
      }));

      // Verify the move was successful
      const tab = await chrome.tabs.get(tabId);
      return tab.groupId === targetGroupId;

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to move single tab to group', {
        tabId,
        targetGroupId,
        error: getErrorMessage(error)
      });
      return false;
    }
  }

  /**
   * Update group title and color based on per-window naming policy
   */
  private async updateGroupProperties(groupId: number, bucket: TabBucket): Promise<void> {
    try {
      // Get group for property updates
      let group;
      try {
        group = await chrome.tabGroups.get(groupId);
      } catch (error) {
        logger.debug(LogCategory.GROUP, 'Could not access group for property updates', {
          groupId,
          error: getErrorMessage(error)
        });
        return;
      }
      
      // Compute title and get stored color
      const title = await this.computeGroupTitle(bucket);
      const branch = await storage.getBranch(bucket.appId, bucket.versionId);
      const color = branch?.color || null;
      
      // Prepare updates
      const updates = this.prepareGroupUpdates(group, title, color);
      
      // Apply updates if needed
      if (Object.keys(updates).length > 0) {
        await this.applyGroupUpdates(groupId, updates);
      }

    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to update group properties', {
        groupId,
        bucket: bucket.key,
        error: getErrorMessage(error)
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


  /**
   * Compute group title based on per-window naming policy
   */
  private async computeGroupTitle(bucket: TabBucket, includeDisplayName: boolean = true): Promise<string> {
    // Get version label with priority:
    // 1. displayName (user override) - if includeDisplayName is true
    // 2. Test/Live for reserved versions  
    // 3. name (scraped branch name)
    // 4. versionId (fallback)
    let versionLabel = bucket.versionId;
    
    try {
      const branch = await storage.getBranch(bucket.appId, bucket.versionId);
      
      if (includeDisplayName && branch?.displayName) {
        // Always use user's displayName verbatim - don't add appId suffix
        return branch.displayName;
      }
      
      // Check for reserved versions (test/live)
      const reservedColor = this.getReservedColor(bucket.versionId);
      if (reservedColor) {
        versionLabel = bucket.versionId.charAt(0).toUpperCase() + bucket.versionId.slice(1);
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
    const extensionGroups = await storage.getExtensionGroups();

    for (const groupId of extensionGroups) {
      try {
        // Query tabs in this group
        const tabs = await chrome.tabs.query({ groupId: groupId });
        
        if (tabs.length === 0) {
          continue; // Preserve empty groups with their colors and user customizations
        }
        
      } catch (error) {
        // Group no longer exists
        groupsToDelete.push(groupId);
      }
    }

    // Remove non-existent groups from tracking
    for (const groupId of groupsToDelete) {
      await storage.removeExtensionGroup(groupId);
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
   * Handle tab identity change - release hold and move tab to correct group
   */
  async handleTabIdentityChange(tabId: number, newAppId: string, newVersionId: string): Promise<void> {
    const hold = this.manualHolds.get(tabId);
    if (hold && (hold.appId !== newAppId || hold.versionId !== newVersionId)) {
      this.manualHolds.delete(tabId);
    }
    
    // Mark tab as having active identity change to prevent contamination
    this.activeIdentityChanges.add(tabId);
    
    // Move tab to correct group for new identity
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.windowId) return;
      
      const bucket = {
        key: `${newAppId}:${newVersionId}`,
        windowId: tab.windowId,
        appId: newAppId,
        versionId: newVersionId,
        tabs: [tab]
      };
      
      // Find or create target group for new identity  
      const targetGroupId = await this.findOrCreateGroup(bucket);
      
      if (targetGroupId && tab.groupId !== targetGroupId) {
        // Move tab to target group
        const moveSuccess = await this.moveSingleTabToGroup(tabId, targetGroupId);
        
        if (moveSuccess) {
          // Only refresh the target group to prevent source group contamination
          await this.refreshTitlesForIdentity(newAppId, newVersionId, targetGroupId);
          logger.info(LogCategory.GROUP, 'Tab successfully moved to correct group after identity change', {
            tabId, 
            newAppId, 
            newVersionId,
            fromGroupId: tab.groupId,
            toGroupId: targetGroupId
          });
        } else {
          logger.error(LogCategory.GROUP, 'Tab move failed - group properties not updated', {
            tabId, 
            newAppId, 
            newVersionId,
            targetGroupId
          });
        }
      } else {
        logger.debug(LogCategory.GROUP, 'No move needed for tab identity change', {
          tabId,
          newAppId,
          newVersionId,
          targetGroupId,
          currentGroupId: tab.groupId
        });
      }
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to move tab after identity change', {
        tabId, newAppId, newVersionId, error
      });
    } finally {
      // Always clear the identity change flag
      this.activeIdentityChanges.delete(tabId);
    }
  }

  /**
   * Handle user renaming a group - store as displayName only if it's truly a user rename
   */
  async handleUserGroupRename(groupId: number, newTitle: string): Promise<void> {
    const groupIdentity = await this.getGroupIdentity(groupId);
    if (!groupIdentity) {
      return;
    }

    try {
      // Check if this title matches what we would generate automatically
      const bucket = {
        windowId: groupIdentity.windowId,
        appId: groupIdentity.appId,
        versionId: groupIdentity.versionId,
        tabs: [], // Not needed for title computation
        key: `${groupIdentity.appId}:${groupIdentity.versionId}`
      };
      
      // Compute what the automatic title would be (without displayName)
      const automaticTitle = await this.computeGroupTitle(bucket, false);
      
      // If the new title matches the automatic title, don't store it as displayName
      if (newTitle === automaticTitle) {
        return;
      }
      
      // This is a genuine user rename - store as displayName
      let branch = await storage.getBranch(groupIdentity.appId, groupIdentity.versionId);
      if (!branch) {
        branch = { 
          appId: groupIdentity.appId, 
          versionId: groupIdentity.versionId, 
          updatedAt: Date.now() 
        };
      }
      
      branch.displayName = newTitle;
      branch.updatedAt = Date.now();
      
      await storage.setBranch(groupIdentity.appId, groupIdentity.versionId, branch);
      
      logger.info(LogCategory.GROUP, 'Stored user group rename as displayName', {
        groupId,
        appId: groupIdentity.appId,
        versionId: groupIdentity.versionId,
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
    const groupIdentity = await this.getGroupIdentity(groupId);
    if (!groupIdentity) {
      return;
    }

    try {
      // Get current color before updating
      const currentBranch = await storage.getBranch(groupIdentity.appId, groupIdentity.versionId);
      const oldColor = currentBranch?.color;
      
      // Check if this is a reserved color that shouldn't be overridden
      const reservedColor = this.getReservedColor(groupIdentity.versionId);
      if (reservedColor && newColor !== reservedColor) {
        logger.info(LogCategory.GROUP, 'User changed color for reserved version', {
          groupId,
          versionId: groupIdentity.versionId,
          reservedColor,
          userColor: newColor,
          appId: groupIdentity.appId
        });
      }

      // Always persist user color choice
      await this.persistBranchColor(groupIdentity.appId, groupIdentity.versionId, newColor);
      
      logger.info(LogCategory.GROUP, 'User group color change persisted', {
        groupId,
        appId: groupIdentity.appId,
        versionId: groupIdentity.versionId,
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
   * Handle group removal - clean up tracking
   */
  async handleGroupRemoval(groupId: number): Promise<void> {
    // Remove from extension groups tracking
    await storage.removeExtensionGroup(groupId);
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
  async refreshTitlesForIdentity(appId: string, versionId: string, targetGroupId?: number): Promise<void> {
    // Find all groups with this identity using direct Chrome API queries
    const allGroups = await chrome.tabGroups.query({});
    const groupsToUpdate: number[] = [];
    
    for (const group of allGroups) {
      // If targetGroupId specified, only update that specific group
      if (targetGroupId && group.id !== targetGroupId) {
        continue;
      }
      
      const identity = await this.getGroupIdentity(group.id);
      if (identity?.appId === appId && identity?.versionId === versionId) {
        groupsToUpdate.push(group.id);
      }
    }

    if (groupsToUpdate.length === 0) {
      return;
    }

    // Update each group's title
    for (const groupId of groupsToUpdate) {
      const identity = await this.getGroupIdentity(groupId);
      if (!identity) continue;

      // Get tabs in this group to determine title
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length === 0) continue;

      // Create a bucket for title computation
      const bucket: TabBucket = {
        windowId: identity.windowId,
        appId: identity.appId,
        versionId: identity.versionId,
        tabs,
        key: `${identity.appId}:${identity.versionId}`
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
   * Find existing group by identity using direct Chrome API queries
   */
  private async findGroupByIdentity(windowId: number, appId: string, versionId: string): Promise<number | null> {
    const groups = await chrome.tabGroups.query({ windowId });
    
    for (const group of groups) {
      const identity = await this.getGroupIdentity(group.id);
      if (identity?.appId === appId && identity?.versionId === versionId) {
        return group.id;
      }
    }
    return null;
  }


  /**
   * Get group identity for a specific group ID using direct Chrome API queries
   */
  private async getGroupIdentity(groupId: number): Promise<{appId: string, versionId: string, windowId: number} | null> {
    const tabs = await chrome.tabs.query({ groupId });
    for (const tab of tabs) {
      // Skip tabs that are currently changing identity to prevent contamination
      if (this.activeIdentityChanges.has(tab.id!)) {
        continue;
      }
      
      const identity = groupRegistry.getIdentity(tab.id!);
      if (identity) {
        return {
          appId: identity.appId,
          versionId: identity.versionId,
          windowId: tab.windowId!
        };
      }
    }
    return null;
  }

  /**
   * Get current statistics for debugging
   */
  getStats() {
    return {
      manualHolds: this.manualHolds.size,
      internalOps: this.internalOps.size,
      debounceActive: this.debounceTimer !== null
    };
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