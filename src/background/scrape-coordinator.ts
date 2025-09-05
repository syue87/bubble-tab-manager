import { logger, LogCategory, getErrorMessage } from '../lib/logger';
import { storage } from '../lib/storage';
import { groupRegistry } from './registry';
import { groupingEngine, isReservedVersion } from './grouping';
import { TIMING } from '../lib/constants';

interface ScrapeState {
  lastScrapeTime: number;
  pendingRequest: boolean;
  scheduledTimer?: ReturnType<typeof setTimeout>;
}

export class ScrapeCoordinator {
  private scrapeStates = new Map<string, ScrapeState>();
  private readonly THROTTLE_MS = TIMING.SCRAPE_THROTTLE;
  private readonly REFRESH_MS = TIMING.CACHE_REFRESH;
  
  // Track periodic timers
  private refreshTimers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Request a branch name scrape for an identity
   */
  async requestScrape(appId: string, versionId: string, trigger: string): Promise<void> {
    logger.info(LogCategory.SCRAPE, 'Scrape requested', {
      appId,
      versionId,
      trigger
    });
    
    // Skip test/live versions - they use fixed labels
    if (isReservedVersion(versionId)) {
      logger.info(LogCategory.SCRAPE, 'Skipping test/live version', { versionId });
      return;
    }

    const key = `${appId}:${versionId}`;
    const state = this.scrapeStates.get(key);
    const now = Date.now();

    // Check throttle
    if (state && (now - state.lastScrapeTime) < this.THROTTLE_MS) {
      if (!state.pendingRequest) {
        // Schedule for after throttle expires
        const delay = this.THROTTLE_MS - (now - state.lastScrapeTime);
        state.pendingRequest = true;
        state.scheduledTimer = setTimeout(() => {
          this.executeScrape(appId, versionId, 'throttled-retry');
        }, delay);
      }
      return;
    }

    // Execute scrape
    await this.executeScrape(appId, versionId, trigger);
  }

  /**
   * Execute scrape for an identity
   */
  private async executeScrape(appId: string, versionId: string, trigger: string): Promise<void> {
    const key = `${appId}:${versionId}`;
    
    // Update state
    this.scrapeStates.set(key, {
      lastScrapeTime: Date.now(),
      pendingRequest: false
    });

    // Select best tab for scraping (prefer visible/active)
    const tabId = await this.selectTabForScraping(appId, versionId);
    if (!tabId) {
      logger.debug(LogCategory.SCRAPE, 'No suitable tab for scraping', { appId, versionId });
      return;
    }

    try {
      logger.info(LogCategory.SCRAPE, 'Sending scrape request to tab', { tabId, appId, versionId });
      
      // First check if tab still exists and is ready
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
        if (!tab || tab.status !== 'complete') {
          logger.debug(LogCategory.SCRAPE, 'Tab not ready for scraping', { 
            tabId, 
            status: tab?.status || 'not found',
            url: tab?.url?.substring(0, 100)
          });
          return;
        }
      } catch (tabError) {
        logger.debug(LogCategory.SCRAPE, 'Tab no longer exists for scraping', { tabId, error: String(tabError) });
        return;
      }
      
      // First ping the content script to ensure it's ready
      logger.debug(LogCategory.SCRAPE, 'Attempting to ping content script', { tabId });
      try {
        const pingResponse = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        logger.debug(LogCategory.SCRAPE, 'Ping response received', { tabId, response: pingResponse });
        if (!pingResponse || pingResponse.type !== 'PONG') {
          logger.debug(LogCategory.SCRAPE, 'Content script not responding to ping correctly', { tabId, response: pingResponse });
          return;
        }
        logger.debug(LogCategory.SCRAPE, 'Content script ping successful', { tabId });
      } catch (pingError) {
        logger.debug(LogCategory.SCRAPE, 'Content script ping failed, script may not be loaded', { 
          tabId, 
          error: pingError instanceof Error ? pingError.message : String(pingError),
          errorName: pingError instanceof Error ? pingError.name : 'Unknown'
        });
        return;
      }
      
      // Send scrape request to content script with timeout (increased to 10s for complex pages)
      let response: { success: boolean; branchName?: string; error?: string };
      
      try {
        const messagePromise = chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_BRANCH_NAME' }).catch(msgError => {
          // Handle specific Chrome runtime errors
          if (chrome.runtime.lastError) {
            throw new Error(`Chrome runtime error: ${chrome.runtime.lastError.message}`);
          }
          throw msgError;
        });
        
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`Scrape request timeout after ${TIMING.SCRAPE_TIMEOUT/1000} seconds`)), TIMING.SCRAPE_TIMEOUT)
        );
        
        response = await Promise.race([messagePromise, timeoutPromise]) as { success: boolean; branchName?: string; error?: string };
      } catch (error) {
        // Handle both message sending errors and timeout errors properly
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        response = { success: false, error: errorMessage };
        logger.info(LogCategory.SCRAPE, 'Scrape request failed', { tabId, error: errorMessage });
      }

      logger.info(LogCategory.SCRAPE, 'Scrape response received', {
        tabId,
        success: response.success,
        branchName: response.branchName,
        error: response.error
      });

      if (response.success && response.branchName) {
        await this.updateBranchName(appId, versionId, response.branchName);
      }
    } catch (error) {
      logger.error(LogCategory.SCRAPE, `Scrape failed: ${getErrorMessage(error)}`, {
        appId, 
        versionId, 
        trigger,
        tabId,
        error: error instanceof Error ? error.name : typeof error
      });
    }
  }


  /**
   * Select best tab for scraping
   */
  private async selectTabForScraping(appId: string, versionId: string): Promise<number | null> {
    // Get all tabs with this identity from registry
    const allWindows = groupRegistry.getStats().tabsByWindow;
    const candidateTabs: number[] = [];

    for (const windowId of Object.keys(allWindows)) {
      const tabs = groupRegistry.getTabs(parseInt(windowId), appId, versionId);
      candidateTabs.push(...Array.from(tabs));
    }

    logger.debug(LogCategory.SCRAPE, 'Candidate tabs for scraping', { 
      appId, 
      versionId, 
      candidateTabs: candidateTabs.length > 0 ? candidateTabs : 'none'
    });

    if (candidateTabs.length === 0) {
      return null;
    }

    // Verify tabs still exist and are ready
    const validTabs: number[] = [];
    for (const tabId of candidateTabs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete') {
          validTabs.push(tabId);
        } else {
          logger.debug(LogCategory.SCRAPE, 'Tab not ready for scraping', { tabId, status: tab?.status });
        }
      } catch (error) {
        logger.debug(LogCategory.SCRAPE, 'Tab no longer exists', { tabId });
      }
    }

    if (validTabs.length === 0) {
      logger.debug(LogCategory.SCRAPE, 'No valid tabs found for scraping');
      return null;
    }

    // Try to find best tab (prefer active/visible)
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs.find(t => t.id && validTabs.includes(t.id));
      if (activeTab?.id) {
        logger.debug(LogCategory.SCRAPE, 'Selected active tab for scraping', { tabId: activeTab.id });
        return activeTab.id;
      }
    } catch (error) {
      // Fall through to use first candidate
    }

    // Use first available editor tab
    for (const tabId of validTabs) {
      const entry = groupRegistry.getIdentity(tabId);
      if (entry && entry.type === 'editor') {
        logger.debug(LogCategory.SCRAPE, 'Selected editor tab for scraping', { tabId });
        return tabId;
      }
    }

    // Use first valid tab
    const selectedTab = validTabs[0];
    logger.debug(LogCategory.SCRAPE, 'Selected first valid tab for scraping', { tabId: selectedTab });
    return selectedTab;
  }

  /**
   * Update branch name in storage and trigger title updates
   */
  private async updateBranchName(appId: string, versionId: string, branchName: string): Promise<void> {
    // Get current branch data
    const branch = await storage.getBranch(appId, versionId);
    
    // Check if name actually changed
    if (branch?.name === branchName) {
      return; // No change
    }

    // Update storage (preserve existing data including color and displayName)
    await storage.setBranch(appId, versionId, {
      ...(branch || { appId, versionId }),
      name: branchName,
      updatedAt: Date.now()
    });

    logger.info(LogCategory.SCRAPE, 'Branch name updated', {
      appId,
      versionId,
      oldName: branch?.name,
      newName: branchName
    });

    // Trigger title refresh for this identity (no tab movement)
    await groupingEngine.refreshTitlesForIdentity(appId, versionId);
  }

  /**
   * Handle new identity detection
   */
  async handleNewIdentity(appId: string, versionId: string): Promise<void> {
    // Skip test/live
    if (isReservedVersion(versionId)) {
      return;
    }

    const key = `${appId}:${versionId}`;
    
    // Set up periodic refresh if not already set
    if (!this.refreshTimers.has(key)) {
      const timer = setInterval(() => {
        this.requestScrape(appId, versionId, 'periodic-refresh');
      }, this.REFRESH_MS);
      this.refreshTimers.set(key, timer);
    }

    // Request initial scrape
    await this.requestScrape(appId, versionId, 'new-identity');
  }

  /**
   * Handle tab visibility change
   */
  async handleTabVisible(_tabId: number, appId: string, versionId: string): Promise<void> {
    await this.requestScrape(appId, versionId, 'tab-visible');
  }

  /**
   * Handle URL change in editor
   */
  async handleUrlChange(_tabId: number, appId: string, versionId: string): Promise<void> {
    await this.requestScrape(appId, versionId, 'url-change');
  }

  /**
   * Clean up timers for identities no longer in use
   */
  cleanup(): void {
    // Clear all refresh timers
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer);
    }
    this.refreshTimers.clear();

    // Clear scheduled timers
    for (const state of this.scrapeStates.values()) {
      if (state.scheduledTimer) {
        clearTimeout(state.scheduledTimer);
      }
    }
    this.scrapeStates.clear();
  }

  /**
   * Force scrape for debugging (dev only)
   */
  async forceScrape(appId: string, versionId: string): Promise<void> {
    const key = `${appId}:${versionId}`;
    // Clear throttle state
    this.scrapeStates.delete(key);
    // Execute immediately
    await this.executeScrape(appId, versionId, 'forced-debug');
  }
}

// Singleton instance
export const scrapeCoordinator = new ScrapeCoordinator();