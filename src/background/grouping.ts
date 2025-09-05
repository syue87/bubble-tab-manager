import { logger, LogCategory, getErrorMessage } from '../lib/logger';
import { storage, type BranchData } from '../lib/storage';
import { groupRegistry } from './registry';
import { VERSION_ID } from '../lib/constants';
import { groupPersistence } from '../lib/group-persistence';

const RESERVED_COLORS = {
  'live': 'green' as chrome.tabGroups.ColorEnum,
  'test': 'blue' as chrome.tabGroups.ColorEnum,
} as const;

/**
 * Check if version ID is a reserved version (test/live)
 */
export function isReservedVersion(versionId: string): boolean {
  return versionId in RESERVED_COLORS;
}

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
              !this.hasManualHold(entry.tabId, entry.appId, entry.versionId)) {
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
      await this.updateGroupProperties(groupId, bucket, undefined);

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
    const { key, tabs, appId, versionId, windowId } = bucket;
    
    logger.info(LogCategory.GROUP, 'Finding or creating group', {
      key,
      tabCount: tabs.length,
      tabIds: tabs.map(t => t.id),
      appId,
      versionId
    });

    // Look for existing group with this identity
    const existingGroupId = await this.findGroupByIdentity(windowId, appId, versionId);
    if (existingGroupId) {
      return existingGroupId;
    }

    // Create new group
    try {
      this.markInternalOp(`create-group-${Date.now()}`);
      
      const groupId = await this.retryTabOperation(() => chrome.tabs.group({
        tabIds: [tabs[0].id!],
      }));

      // Track that we created this group
      await storage.addExtensionGroup(groupId);

      // Set initial title immediately (fallback that will be updated later)
      const initialTitle = this.shouldCleanVersionId(versionId) 
        ? this.cleanVersionIdForDisplay(versionId) 
        : versionId;
      await this.applyGroupUpdates(groupId, { title: initialTitle });

      // Set color ONLY if branch has stored color OR is test/live
      const existingBranch = await storage.getBranch(appId, versionId);
      const reservedColor = this.getReservedColor(versionId);
      
      if (existingBranch?.color) {
        // Branch has stored color preference - apply it
        await this.applyGroupUpdates(groupId, { color: existingBranch.color });
        logger.info(LogCategory.GROUP, 'Applied stored color preference to new group', {
          groupId,
          versionId,
          color: existingBranch.color
        });
      } else if (reservedColor) {
        // No stored preference but is test/live - apply reserved color
        await this.applyGroupUpdates(groupId, { color: reservedColor });
        await this.persistBranchColor(appId, versionId, reservedColor);
        logger.info(LogCategory.GROUP, 'Applied reserved color to new group', {
          groupId,
          versionId,
          color: reservedColor
        });
      }
      // If no stored color AND not test/live, let Chrome auto-assign color

      // Store group mapping for service worker suspension recovery
      await groupPersistence.storeGroupMapping(groupId, appId, versionId, windowId);

      logger.info(LogCategory.GROUP, 'Created new group', { 
        groupId: groupId, 
        identity: key 
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
   * Prepare group updates by comparing current state with desired state
   */
  private prepareGroupUpdates(
    group: chrome.tabGroups.TabGroup, 
    title: string, 
    color?: chrome.tabGroups.ColorEnum
  ): chrome.tabGroups.UpdateProperties {
    const updates: chrome.tabGroups.UpdateProperties = {};
    
    if (group.title !== title) {
      updates.title = title;
    }
    
    // Only update color if we have a specific color to set AND it's different
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
  private async computeGroupTitle(bucket: TabBucket, includeDisplayName: boolean = true, branch?: BranchData): Promise<string> {
    const { appId, versionId, windowId } = bucket;
    
    // Get version label with priority:
    // 1. displayName (user override) - if includeDisplayName is true
    // 2. Test/Live for reserved versions  
    // 3. name (scraped branch name)
    // 4. versionId (fallback, but clean it up)
    let versionLabel = versionId;
    
    try {
      // Use provided branch data or fetch if not provided
      const branchData = branch ?? await storage.getBranch(appId, versionId);
      
      
      if (includeDisplayName && branchData?.displayName) {
        // Always use user's displayName verbatim - don't add appId suffix
        return branchData.displayName;
      }
      
      // Check for reserved versions (test/live)
      const reservedColor = this.getReservedColor(versionId);
      if (reservedColor) {
        versionLabel = versionId.charAt(0).toUpperCase() + versionId.slice(1);
      } else if (branchData?.name) {
        // Use scraped branch name
        versionLabel = branchData.name;
      }
      // If still using raw versionId, only clean it up if it's truly problematic
      if (versionLabel === versionId && this.shouldCleanVersionId(versionId)) {
        versionLabel = this.cleanVersionIdForDisplay(versionId);
      }
    } catch (error) {
      // Continue with fallback - use raw versionId unless it's problematic
      if (this.shouldCleanVersionId(versionId)) {
        versionLabel = this.cleanVersionIdForDisplay(versionId);
      }
    }

    // Determine if window is single-app or multi-app
    const isMultiApp = await this.isMultiAppWindow(windowId);
    
    // Apply per-window naming policy
    const finalTitle = isMultiApp ? `${versionLabel} | ${appId}` : versionLabel;
    
    return finalTitle;
  }

  /**
   * Check if versionId should be cleaned up for display
   */
  private shouldCleanVersionId(versionId: string): boolean {
    if (!versionId || versionId.trim() === '') {
      return true; // Empty strings need cleanup
    }
    
    // Long strings that look like UUIDs/hashes need cleanup
    if (versionId.length > VERSION_ID.MAX_DISPLAY_LENGTH && /^[a-f0-9-]+$/i.test(versionId)) {
      return true;
    }
    
    // Normal branch names like "main", "development", "feature-branch" are fine as-is
    return false;
  }

  /**
   * Clean up versionId for better display when no branch name is available
   */
  private cleanVersionIdForDisplay(versionId: string): string {
    if (!versionId || versionId.trim() === '') {
      return 'Unknown Branch';
    }
    
    // If it looks like a UUID or hash, truncate it
    if (versionId.length > VERSION_ID.MAX_DISPLAY_LENGTH && /^[a-f0-9-]+$/i.test(versionId)) {
      return versionId.substring(0, 8) + '...';
    }
    
    // If it has underscores or dashes, make it more readable
    return versionId.replace(/[_-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
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
   * Persist branch color to storage
   */
  private async persistBranchColor(appId: string, versionId: string, color: chrome.tabGroups.ColorEnum): Promise<void> {
    try {
      let branch = await storage.getBranch(appId, versionId);
      if (!branch) {
        branch = this.createDefaultBranch(appId, versionId);
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
          // Empty groups are preserved with their colors and user customizations
          continue;
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
    
    // Physical-first approach: move first, update registry after
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
          logger.info(LogCategory.GROUP, 'Tab successfully moved to correct group after identity change', {
            tabId, 
            newAppId, 
            newVersionId,
            fromGroupId: tab.groupId,
            toGroupId: targetGroupId
          });
          
          // Return success - registry will be updated by caller after physical move
          // Title will be updated later when branch data is available
          return;
        } else {
          logger.error(LogCategory.GROUP, 'Tab move failed - registry will not be updated', {
            tabId, 
            newAppId, 
            newVersionId,
            targetGroupId
          });
          throw new Error('Physical tab move failed');
        }
      } else {
        logger.debug(LogCategory.GROUP, 'No move needed for tab identity change', {
          tabId,
          newAppId,
          newVersionId,
          targetGroupId,
          currentGroupId: tab.groupId
        });
        // No move needed, but registry can still be updated by caller
      }
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to move tab after identity change', {
        tabId, newAppId, newVersionId, error
      });
      throw error; // Re-throw to prevent registry update
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
      
      // Get branch data once for both title computation and storage
      let branch = await storage.getBranch(groupIdentity.appId, groupIdentity.versionId);
      
      // Compute what the automatic title would be (without displayName)
      const automaticTitle = await this.computeGroupTitle(bucket, false, branch);
      
      // If the new title matches the automatic title, don't store it as displayName
      if (newTitle === automaticTitle) {
        return;
      }
      
      // This is a genuine user rename - store as displayName
      if (!branch) {
        branch = this.createDefaultBranch(groupIdentity.appId, groupIdentity.versionId);
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
   * Recover from service worker suspension by rebuilding group knowledge
   * Called during initialization to restore group→identity mappings
   */
  async recoverFromSuspension(): Promise<void> {
    try {
      // Clean up any stale group mappings first
      await groupPersistence.cleanupStaleGroups();
      
      logger.info(LogCategory.GROUP, 'Group suspension recovery complete');
    } catch (error) {
      logger.error(LogCategory.GROUP, 'Failed to recover from service worker suspension', {
        error: getErrorMessage(error)
      });
    }
  }

  /**
   * Handle group removal - clean up tracking
   */
  async handleGroupRemoval(groupId: number): Promise<void> {
    // Remove from extension groups tracking
    await storage.removeExtensionGroup(groupId);
    
    // Remove from persistent group mappings
    await groupPersistence.removeGroupMapping(groupId);
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
    }, VERSION_ID.CLEANUP_TIMEOUT);
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
   * IMPORTANT: This should ONLY update titles, never colors
   */
  async refreshTitlesForIdentity(appId: string, versionId: string, targetGroupId?: number, freshBranchData?: BranchData): Promise<void> {
    let groupsToUpdate: number[] = [];
    
    if (targetGroupId) {
      // Direct update for specific group - no scanning needed
      groupsToUpdate = [targetGroupId];
    } else {
      // First try: Use persistence layer for direct lookup (much faster)
      try {
        const persistedGroups = await groupPersistence.findGroupsForIdentity(appId, versionId);
        
        // Validate that these groups still exist
        for (const groupId of persistedGroups) {
          try {
            await chrome.tabGroups.get(groupId); // Quick existence check
            groupsToUpdate.push(groupId);
          } catch {
            // Group no longer exists, persistence will clean it up later
          }
        }
      } catch (error) {
        logger.debug(LogCategory.GROUP, 'Persistence lookup failed for title refresh, falling back to full scan', {
          appId,
          versionId,
          error
        });
      }
      
      // Fallback: Only scan if persistence lookup found nothing
      if (groupsToUpdate.length === 0) {
        const allGroups = await chrome.tabGroups.query({});
        
        for (const group of allGroups) {
          // Try registry + persistence first, then fallback to URL parsing for title-only updates
          let identity = await this.getGroupIdentity(group.id);
          
          // URL-based fallback as last resort when both registry and persistence are unavailable
          if (!identity) {
            identity = await this.getGroupIdentityFromUrls(group.id);
          }
          
          if (identity?.appId === appId && identity?.versionId === versionId) {
            groupsToUpdate.push(group.id);
          }
        }
      }
    }

    if (groupsToUpdate.length === 0) {
      return;
    }

    // Update each group's title
    for (const groupId of groupsToUpdate) {
      // Use same fallback logic as above
      let identity = await this.getGroupIdentity(groupId);
      if (!identity) {
        identity = await this.getGroupIdentityFromUrls(groupId);
      }
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

      // Update group properties with fresh branch data if provided
      await this.updateGroupProperties(groupId, bucket, freshBranchData);
    }
  }


  /**
   * Debounced planning - coalesce rapid events
   */
  debouncedPlan(reason: string, delayMs = VERSION_ID.DEBOUNCE_DELAY): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.planAndExecuteGrouping(reason);
    }, delayMs);
  }



  /**
   * Find existing group by identity using persistence layer + Chrome API validation
   * Enhanced to survive service worker suspension
   */
  private async findGroupByIdentity(windowId: number, appId: string, versionId: string): Promise<number | null> {
    // First try: Check persisted mappings for direct lookup
    try {
      const candidateGroupIds = await groupPersistence.findGroupsForIdentity(appId, versionId, windowId);
      
      // Validate that these groups actually exist and are in the right window
      for (const groupId of candidateGroupIds) {
        try {
          const group = await chrome.tabGroups.get(groupId);
          if (group.windowId === windowId) {
            // Update the lastSeen timestamp
            await groupPersistence.touchGroupMapping(groupId);
            
            logger.debug(LogCategory.GROUP, 'Found group via persistence', {
              groupId,
              appId,
              versionId,
              windowId
            });
            return groupId;
          }
        } catch {
          // Group no longer exists, persistence will clean it up later
        }
      }
    } catch (error) {
      logger.debug(LogCategory.GROUP, 'Persistence lookup failed, falling back to registry', {
        appId,
        versionId,
        error
      });
    }
    
    // Fallback: Use registry-based lookup (existing logic)
    const groups = await chrome.tabGroups.query({ windowId });
    
    for (const group of groups) {
      const identity = await this.getGroupIdentity(group.id);
      if (identity?.appId === appId && identity?.versionId === versionId) {
        // Store this mapping for future use
        await groupPersistence.storeGroupMapping(group.id, appId, versionId, windowId);
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
    const validIdentities: {appId: string, versionId: string, windowId: number}[] = [];
    
    for (const tab of tabs) {
      const registryIdentity = groupRegistry.getIdentity(tab.id!);
      
      // Registry may be empty after service worker suspension - persistence layer provides fallback
      
      if (registryIdentity) {
        // Validate: only trust registry if tab is actually in this group physically
        try {
          const actualTab = await chrome.tabs.get(tab.id!);
          if (actualTab.groupId === groupId) {
            // Registry matches physical reality - this identity is valid
            validIdentities.push({
              appId: registryIdentity.appId,
              versionId: registryIdentity.versionId,
              windowId: tab.windowId!
            });
          }
          // If actualTab.groupId !== groupId, registry is stale - ignore this tab
        } catch {
          // Tab no longer exists - ignore
        }
      }
    }
    
    if (validIdentities.length === 0) {
      // Fallback: Check persistence layer when registry is empty
      try {
        const persistedMapping = await groupPersistence.getGroupMapping(groupId);
        if (persistedMapping) {
          // Verify the group still exists in the expected window
          const group = await chrome.tabGroups.get(groupId);
          if (group.windowId === persistedMapping.windowId) {
            logger.debug(LogCategory.GROUP, 'Group identity recovered from persistence', {
              groupId,
              appId: persistedMapping.appId,
              versionId: persistedMapping.versionId
            });
            
            // Update lastSeen timestamp
            await groupPersistence.touchGroupMapping(groupId);
            
            return {
              appId: persistedMapping.appId,
              versionId: persistedMapping.versionId,
              windowId: persistedMapping.windowId
            };
          }
        }
      } catch (error) {
        logger.debug(LogCategory.GROUP, 'Persistence fallback failed for group identity', {
          groupId,
          error
        });
      }
      
      return null;
    }
    
    // Return majority identity from validated identities
    const identity = this.findMajorityIdentity(validIdentities);
    
    // Store successful registry lookup in persistence for future use
    if (identity) {
      await groupPersistence.storeGroupMapping(groupId, identity.appId, identity.versionId, identity.windowId);
    }
    
    return identity;
  }

  /**
   * Update group title based on per-window naming policy
   * NOTE: This method NEVER changes colors - colors are only set during group creation or user changes
   */
  private async updateGroupProperties(groupId: number, bucket: TabBucket, branchData?: BranchData): Promise<void> {
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
      
      // Use provided branch data or fetch from storage as fallback
      const branch = branchData ?? await storage.getBranch(bucket.appId, bucket.versionId);
      const title = await this.computeGroupTitle(bucket, true, branch);
      
      // This method NEVER changes colors to prevent contamination
      const updates = this.prepareGroupUpdates(group, title, undefined);
      
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
   * Create default branch data structure
   */
  private createDefaultBranch(appId: string, versionId: string) {
    return { appId, versionId, updatedAt: Date.now() };
  }

  /**
   * Find majority identity from a list of identities (shared logic)
   */
  private findMajorityIdentity(identities: Array<{appId: string, versionId: string, windowId: number}>): {appId: string, versionId: string, windowId: number} | null {
    if (identities.length === 0) {
      return null;
    }
    
    const identityCount = new Map<string, number>();
    const identityDetails = new Map<string, {appId: string, versionId: string, windowId: number}>();
    
    for (const identity of identities) {
      const key = `${identity.appId}:${identity.versionId}`;
      identityCount.set(key, (identityCount.get(key) || 0) + 1);
      identityDetails.set(key, identity);
    }
    
    let majorityKey = '';
    let maxCount = 0;
    for (const [key, count] of identityCount) {
      if (count > maxCount) {
        maxCount = count;
        majorityKey = key;
      }
    }
    
    return identityDetails.get(majorityKey) || null;
  }

  /**
   * Get group identity from URLs (safe fallback for title updates only)
   * Only works for well-formed Bubble editor URLs to prevent contamination
   */
  private async getGroupIdentityFromUrls(groupId: number): Promise<{appId: string, versionId: string, windowId: number} | null> {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      const identities: {appId: string, versionId: string, windowId: number}[] = [];
      
      // Import once for all tabs
      const { parseTabIdentity } = await import('../lib/identity');
      
      for (const tab of tabs) {
        if (tab.url && tab.url.includes('bubble.io/page?') && 
            tab.url.includes('id=') && tab.url.includes('version=') && tab.windowId) {
          
          const urlIdentity = await parseTabIdentity(tab.url);
          
          if (urlIdentity && urlIdentity.type === 'editor') {
            identities.push({
              appId: urlIdentity.appId,
              versionId: urlIdentity.versionId,
              windowId: tab.windowId
            });
          }
        }
      }
      
      if (identities.length === 0) {
        return null;
      }
      
      // Return majority identity (same logic as registry-based method)
      return this.findMajorityIdentity(identities);
    } catch (error) {
      return null; // Fail silently for title updates
    }
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