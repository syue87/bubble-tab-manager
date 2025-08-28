import { logger, LogCategory, getErrorMessage } from '../lib/logger';
import { storage } from '../lib/storage';
import { parseTabIdentity, parseTabIdentitySync, isEditorUrl, type TabIdentity } from '../lib/identity';
import { groupRegistry, lastActiveCache } from './registry';
import { groupingEngine, type GroupMapping } from './grouping';
import { scrapeCoordinator } from './scrape-coordinator';
import { lastActiveCache as identityLastActiveCache } from '../lib/last-active-cache';
import { cleanupManager } from '../lib/cleanup-manager';

let initialized = false;

async function getActiveTabGroupColors(): Promise<Set<string>> {
  try {
    const activeColors = new Set<string>();
    const windows = await chrome.windows.getAll();
    
    for (const window of windows) {
      try {
        const groups = await chrome.tabGroups.query({ windowId: window.id });
        for (const group of groups) {
          if (group.color) {
            activeColors.add(group.color);
          }
        }
      } catch (error) {
        // Tab groups API might not be available
      }
    }
    
    return activeColors;
  } catch (error) {
    logger.error(LogCategory.MESSAGE, 'Failed to get active tab group colors', {
      error: String(error)
    });
    return new Set();
  }
}

async function initialize(): Promise<void> {
  if (initialized) return;

  try {
    logger.info(LogCategory.INIT, 'Initializing Bubble Tab Manager');
    
    await storage.initialize();
    await registerMainWorldScript();
    await scanExistingTabs();
    await groupingEngine.recoverGroupMappings();
    
    const groupingEnabled = await storage.isGroupingEnabled();
    if (groupingEnabled) {
      await groupingEngine.planAndExecuteGrouping('initialization');
    }
    
    initialized = true;
    logger.info(LogCategory.INIT, 'Initialization complete');
  } catch (error) {
    logger.error(LogCategory.INIT, 'Initialization failed', error);
    throw error;
  }
}

async function registerMainWorldScript() {
  try {
    const existingScripts = await chrome.scripting.getRegisteredContentScripts();
    const btmMainWorld = existingScripts.find(script => script.id === 'btm-main-world');
    
    if (!btmMainWorld) {
      await chrome.scripting.registerContentScripts([{
        id: 'btm-main-world',
        matches: [
          'https://bubble.io/page*',
          'https://*.bubble.is/page*'
        ],
        js: ['main-world.js'],
        world: 'MAIN',
        runAt: 'document_start'
      }]);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('Duplicate script ID'))) {
      logger.error(LogCategory.INIT, 'Failed to register MAIN-world script', error);
    }
  }
}


async function scanExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    
    const processingResults = await Promise.allSettled(
      tabs.map(async (tab) => {
        if (tab.url && tab.id && tab.windowId) {
          return await processTabIdentity(tab.id, tab.windowId, tab.url);
        }
        return false;
      })
    );
    
    const processedCount = processingResults.filter(
      result => result.status === 'fulfilled' && result.value
    ).length;
    
    logger.info(LogCategory.INIT, 'Tab scan complete', {
      totalTabs: tabs.length,
      processedTabs: processedCount
    });
  } catch (error) {
    logger.error(LogCategory.INIT, 'Tab scan failed', error);
  }
}

/**
 * Validate all strict rules for baseUrl creation
 * Must have debug_mode=true, version path, existing app/version, and correct tab group
 */
async function validateAllRulesForBaseUrl(url: string, tabId: number, appId: string, versionId: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    
    // Must have debug_mode=true parameter
    const hasDebugMode = urlObj.searchParams.get('debug_mode') === 'true';
    if (!hasDebugMode) {
      return false;
    }
    
    // Must have explicit /version-xxx/ in URL path
    const versionMatch = urlObj.pathname.match(/(^|\/)version-([A-Za-z0-9_-]+)(\/|$)/i);
    if (!versionMatch) {
      return false;
    }
    
    // Must have existing app/version combination
    const branch = await storage.getBranch(appId, versionId);
    if (!branch) {
      return false;
    }
    
    // Tab must be in correct group
    const isInCorrectGroup = await validateTabGroupForBaseUrl(tabId, appId, versionId);
    if (!isInCorrectGroup) {
      return false;
    }
    
    logger.info(LogCategory.CUSTOM_DOMAIN, 'BaseUrl validation passed', { appId, versionId });
    
    return true;
  } catch (error) {
    logger.error(LogCategory.CUSTOM_DOMAIN, 'Error validating rules for baseUrl', {
      url: url.substring(0, 100),
      error: String(error)
    });
    return false;
  }
}


/**
 * Validate that a tab is in the correct group for its branch before adding baseUrl
 */
async function validateTabGroupForBaseUrl(tabId: number, appId: string, versionId: string): Promise<boolean> {
  try {
    // Get the tab's current group
    const tab = await chrome.tabs.get(tabId);
    if (!tab.groupId || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return false;
    }

    // Check if this group belongs to the same app/version via grouping engine
    const groupMapping: GroupMapping | undefined = groupingEngine.getGroupMapping(tab.groupId);
    
    if (!groupMapping) {
      return false;
    }

    // Validate that the group mapping matches the expected app/version
    const isValidGroup = groupMapping.appId === appId && groupMapping.versionId === versionId;
    
    return isValidGroup;
  } catch (error) {
    return false; // Fail safe - don't add baseUrl if we can't validate
  }
}

/**
 * Process a tab's identity and update registry/storage
 */
async function processTabIdentity(tabId: number, windowId: number, url: string): Promise<boolean> {
  // Try sync parse first for performance
  let identity = parseTabIdentitySync(url);
  
  // If no standard identity found, try async parsing (includes custom domains)
  if (!identity) {
    identity = await parseTabIdentity(url);
    
    if (!identity) {
      return false; // Not a Bubble URL
    }
    
  }
  
  // Check if this is a new identity
  const oldEntry = groupRegistry.getIdentity(tabId);
  const isNewIdentity = !oldEntry || 
    oldEntry.appId !== identity.appId || 
    oldEntry.versionId !== identity.versionId;
  
  // Update registry
  groupRegistry.setTabIdentity(tabId, windowId, identity, url);
  
  // Update both last-active caches for editor tabs
  if (identity.type === 'editor' && identity.versionId !== 'live') {
    lastActiveCache.set(identity.versionId, identity.appId);
    identityLastActiveCache.recordActivity(identity.appId, identity.versionId);
  }
  
  // For custom domain preview tabs, also record activity for version mapping
  if (identity.type === 'preview' && identity.versionId !== 'live' && 
      !identity.hostname.endsWith('.bubbleapps.io')) {
    identityLastActiveCache.recordActivity(identity.appId, identity.versionId);
    
    // BaseURL creation: Custom domain preview tabs must pass all validation rules
    const passesAllRules = await validateAllRulesForBaseUrl(url, tabId, identity.appId, identity.versionId);
    if (passesAllRules) {
      try {
        await storage.addBaseUrl(identity.appId, identity.hostname);
        logger.info(LogCategory.CUSTOM_DOMAIN, 'Added custom domain to baseUrls', {
          appId: identity.appId,
          hostname: identity.hostname
        });
      } catch (error) {
        logger.error(LogCategory.CUSTOM_DOMAIN, 'Failed to add base URL', {
          appId: identity.appId,
          hostname: identity.hostname,
          error: String(error)
        });
      }
    }
  }
  
  // Update persistent storage
  await updateAppStorage(identity);
  await updateBranchStorage(identity);
  
  // Trigger scraping for new editor identities
  if (isNewIdentity && identity.type === 'editor') {
    try {
      await scrapeCoordinator.handleNewIdentity(identity.appId, identity.versionId);
    } catch (error) {
      logger.error(LogCategory.SCRAPE, 'Failed to handle new identity for scraping', {
        appId: identity.appId,
        versionId: identity.versionId,
        error: getErrorMessage(error)
      });
    }
  }
  
  return true;
}

/**
 * Update app storage with baseUrls management
 */
async function updateAppStorage(identity: TabIdentity) {
  try {
    const { appId, hostname } = identity;
    
    // Get existing app data
    let app = await storage.getApp(appId);
    if (!app) {
      // Create new app
      app = {
        appId,
        baseUrls: [],
        updatedAt: Date.now()
      };
    }
    
    // Ensure <appId>.bubbleapps.io is always included
    const bubbleHost = `${appId}.bubbleapps.io`;
    const baseUrls = new Set(app.baseUrls);
    baseUrls.add(bubbleHost);
    
    // Add current hostname if different
    if (hostname !== bubbleHost) {
      baseUrls.add(hostname);
    }
    
    // Convert back to array and enforce cap of 12 with LRU eviction
    let urlArray = Array.from(baseUrls);
    const now = Date.now();
    
    // Update lastSeen for current hostname
    const urlLastSeen = app.urlLastSeen || {};
    urlLastSeen[hostname] = now;
    
    if (urlArray.length > 12) {
      // Keep bubbleHost and evict least recently used URLs
      const urlsWithLastSeen = urlArray.map(url => ({
        url,
        lastSeen: urlLastSeen[url] || 0
      }));
      
      // Sort by lastSeen (oldest first), but always keep bubbleHost
      const sortedUrls = urlsWithLastSeen
        .filter(item => item.url !== bubbleHost)
        .sort((a, b) => a.lastSeen - b.lastSeen);
      
      // Keep bubbleHost + 11 most recently used URLs
      const finalUrls = [bubbleHost];
      const keepCount = Math.min(11, sortedUrls.length);
      for (let i = sortedUrls.length - keepCount; i < sortedUrls.length; i++) {
        finalUrls.push(sortedUrls[i].url);
      }
      
      urlArray = finalUrls;
      
      // Clean up urlLastSeen for evicted URLs
      for (const url in urlLastSeen) {
        if (!urlArray.includes(url)) {
          delete urlLastSeen[url];
        }
      }
    }
    
    // Update storage
    await storage.setApp(appId, {
      baseUrls: urlArray,
      urlLastSeen,
      updatedAt: Date.now()
    });
    
  } catch (error) {
    logger.error(LogCategory.STORAGE, 'Failed to update app storage', { identity, error });
  }
}

/**
 * Check if a custom domain is recognized (exists in baseUrls)
 */
async function isRecognizedCustomDomain(hostname: string): Promise<boolean> {
  try {
    const apps = await storage.getApps();
    
    for (const app of Object.values(apps)) {
      if (app.baseUrls && app.baseUrls.includes(hostname)) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    logger.error(LogCategory.CUSTOM_DOMAIN, 'Error checking recognized domain', { hostname, error });
    return false; // Fail safe - assume not recognized
  }
}

/**
 * Update branch storage with flexible custom domain logic
 */
async function updateBranchStorage(identity: TabIdentity) {
  try {
    const { appId, versionId, hostname, type } = identity;
    
    // For preview tabs on custom domains (not *.bubbleapps.io), apply flexible rule
    if (type === 'preview' && !hostname.endsWith('.bubbleapps.io')) {
      const isRecognized = await isRecognizedCustomDomain(hostname);
      if (!isRecognized) {
        return; // Don't create branch for unrecognized custom domains
      }
      
      logger.info(LogCategory.CUSTOM_DOMAIN, 'Creating branch for recognized custom domain', {
        hostname,
        appId,
        versionId
      });
    }
    
    // Get existing branch data
    const branch = await storage.getBranch(appId, versionId);
    
    if (!branch) {
      // Create new branch with color assignment
      await storage.setBranch(appId, versionId, {
        appId,
        versionId,
        updatedAt: Date.now()
      });
      
      // Assign color for new branch
      await groupingEngine.assignColorForNewBranch(appId, versionId);
    } else {
      // Update existing branch timestamp
      await storage.setBranch(appId, versionId, {
        updatedAt: Date.now()
      });
    }
    
  } catch (error) {
    logger.error(LogCategory.STORAGE, 'Failed to update branch storage', { identity, error });
  }
}

/**
 * Handle extension installation or update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info(LogCategory.INIT, 'Extension installed/updated', {
    reason: details.reason,
    previousVersion: details.previousVersion,
  });
  
  await initialize();
  
  // Create context menu items
  await createContextMenus();
  
  // Update context menus for the currently active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      await updateContextMenus(activeTab.id);
    }
  } catch (error) {
    logger.debug(LogCategory.INIT, 'Failed to update context menus for active tab', error);
  }
  
  if (details.reason === 'install') {
    logger.info(LogCategory.INIT, 'Fresh install detected');
  }
});

/**
 * Handle browser startup
 */
chrome.runtime.onStartup.addListener(async () => {
  logger.info(LogCategory.INIT, 'Browser startup detected');
  await initialize();
});

/**
 * Tab lifecycle events
 */
chrome.tabs.onCreated.addListener((tab) => {
  // Will be processed on onUpdated when URL is available
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || (changeInfo.status === 'complete' && tab.url)) {
    const url = changeInfo.url || tab.url;
    
    if (url) {
      // Update context menus for this tab
      await updateContextMenus(tabId);
      
      // Process tab identity
      if (tab.windowId !== undefined) {
        const oldIdentity = groupRegistry.getIdentity(tabId);
        await processTabIdentity(tabId, tab.windowId, url);
        
        const newIdentity = groupRegistry.getIdentity(tabId);
        if (oldIdentity && newIdentity && 
            (oldIdentity.appId !== newIdentity.appId || oldIdentity.versionId !== newIdentity.versionId)) {
          groupingEngine.handleTabIdentityChange(tabId, newIdentity.appId, newIdentity.versionId);
        }
        
        if (newIdentity) {
          groupingEngine.debouncedPlan('tab-updated');
        }
      }
      
      // Inject MAIN-world script for editor pages
      if (isEditorUrl(url)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['main-world.js'],
            world: 'MAIN'
          });
        } catch (error) {
          // Continue silently
        }
      }
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Update context menus when switching tabs
  await updateContextMenus(activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  // Clean up tab from registry
  groupRegistry.removeTab(tabId);
  
  // Trigger regrouping after tab removal
  groupingEngine.debouncedPlan('tab-removed');
});

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;
  
  try {
    let newUrl: string;
    
    switch (info.menuItemId) {
      case 'toggle-debug-mode':
        newUrl = toggleUrlParameter(tab.url, 'debug_mode');
        await chrome.tabs.update(tab.id, { url: newUrl });
        logger.info(LogCategory.TAB, 'Toggled debug_mode', { 
          oldUrl: tab.url, 
          newUrl 
        });
        break;
        
      case 'toggle-issues-off':
        newUrl = toggleUrlParameter(tab.url, 'issues_off');
        await chrome.tabs.update(tab.id, { url: newUrl });
        logger.info(LogCategory.TAB, 'Toggled issues_off', { 
          oldUrl: tab.url, 
          newUrl 
        });
        break;
        
    }
  } catch (error) {
    logger.error(LogCategory.TAB, 'Failed to handle context menu action', {
      error: String(error),
      menuItemId: info.menuItemId,
      url: tab.url
    });
  }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  // Get tab info and reprocess identity with new window
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      await processTabIdentity(tabId, attachInfo.newWindowId, tab.url);
      
      // Trigger regrouping after tab attachment
      groupingEngine.debouncedPlan('tab-attached');
    }
  } catch (error) {
    // Continue silently
  }
});

chrome.tabs.onDetached.addListener((tabId, _detachInfo) => {
  // Remove from old location (will be re-added on attach)
  groupRegistry.removeTab(tabId);
  
  // Trigger regrouping after tab detachment
  groupingEngine.debouncedPlan('tab-detached');
});

chrome.tabs.onMoved.addListener(async (tabId, _moveInfo) => {
  // Handle manual tab move - create hold if it was moved out of a group
  const identity = groupRegistry.getIdentity(tabId);
  if (identity) {
    groupingEngine.handleManualTabMove(tabId, identity.appId, identity.versionId);
  }
});

/**
 * Tab group lifecycle events
 */
chrome.tabGroups.onCreated.addListener((_group) => {
  // Group created
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  // Handle user group renames (ignore our own operations)
  if (!groupingEngine.isInternalOp(`update-group-${group.id}`) && group.title) {
    await groupingEngine.handleUserGroupRename(group.id, group.title);
  }
  
  // Handle user group color changes (ignore our own operations)
  if (!groupingEngine.isInternalOp(`update-group-${group.id}`) && group.color) {
    await groupingEngine.handleUserGroupColorChange(group.id, group.color);
  }
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  // Clean up group mapping and tracking
  await groupingEngine.handleGroupRemoval(group.id);
});

/**
 * Handle content script ready event
 */
async function handleContentScriptReady(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  if (sender.tab?.id && sender.tab?.windowId && message.url) {
    await processTabIdentity(sender.tab.id, sender.tab.windowId, message.url);
  }
  return { success: true };
}

/**
 * Handle URL change from content script
 */
async function handleUrlChange(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  if (sender.tab?.id && sender.tab?.windowId && message.url) {
    await processTabIdentity(sender.tab.id, sender.tab.windowId, message.url);
    
    // Trigger scraping on URL change for editor tabs
    const identity = parseTabIdentitySync(message.url);
    if (identity && identity.type === 'editor') {
      try {
        await scrapeCoordinator.handleUrlChange(sender.tab.id, identity.appId, identity.versionId);
      } catch (error) {
        logger.error(LogCategory.SCRAPE, 'Failed to handle URL change for scraping', {
          tabId: sender.tab.id,
          appId: identity.appId,
          versionId: identity.versionId,
          error: getErrorMessage(error)
        });
      }
    }
  }
  return { success: true };
}

/**
 * Handle tab visibility change
 */
async function handleTabVisible(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  if (message.identity && sender.tab?.id) {
    try {
      await scrapeCoordinator.handleTabVisible(
        sender.tab.id, 
        message.identity.appId, 
        message.identity.versionId
      );
    } catch (error) {
      logger.error(LogCategory.SCRAPE, 'Failed to handle tab visible for scraping', {
        tabId: sender.tab.id,
        appId: message.identity.appId,
        versionId: message.identity.versionId,
        error: getErrorMessage(error)
      });
    }
  }
  return { success: true };
}

/**
 * Handle scraping-related messages
 */
async function handleScrapeMessage(message: any): Promise<any> {
  switch (message.type) {
    case 'TRIGGER_IMMEDIATE_SCRAPE':
      if (message.appId && message.versionId) {
        try {
          await scrapeCoordinator.requestScrape(message.appId, message.versionId, 'immediate-trigger');
          return { success: true };
        } catch (error) {
          logger.error(LogCategory.SCRAPE, 'Failed to trigger immediate scrape', { 
            appId: message.appId, 
            versionId: message.versionId, 
            error 
          });
          return { success: false, error: getErrorMessage(error) };
        }
      } else {
        return { success: false, error: 'Missing appId or versionId' };
      }
      
    case 'IMMEDIATE_SCRAPE_RESULT':
      if (message.appId && message.versionId && message.branchName) {
        try {
          await storage.setBranch(message.appId, message.versionId, {
            name: message.branchName,
            updatedAt: Date.now()
          });
          
          logger.info(LogCategory.SCRAPE, 'Immediate scrape result stored', {
            appId: message.appId,
            versionId: message.versionId,
            branchName: message.branchName
          });
          
          await groupingEngine.refreshTitlesForIdentity(message.appId, message.versionId);
          return { success: true };
        } catch (error) {
          logger.error(LogCategory.SCRAPE, 'Failed to process immediate scrape result', { 
            appId: message.appId, 
            versionId: message.versionId,
            branchName: message.branchName,
            error 
          });
          return { success: false, error: getErrorMessage(error) };
        }
      } else {
        return { success: false, error: 'Missing required fields' };
      }
      
    case 'FORCE_SCRAPE':
      if (message.appId && message.versionId) {
        await scrapeCoordinator.forceScrape(message.appId, message.versionId);
        return { success: true, message: 'Scrape executed' };
      } else {
        return { error: 'Missing appId or versionId' };
      }
      
    default:
      return { error: 'Unknown scrape message type' };
  }
}

/**
 * Handle debug-related messages
 */
async function handleDebugMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (message.type) {
    case 'GET_REGISTRY_INFO':
      return {
        stats: groupRegistry.getStats(),
        lastActive: lastActiveCache.getAll(),
        tabIdentity: sender.tab?.id ? groupRegistry.getIdentity(sender.tab.id) : null
      };
      
    case 'DUMP_REGISTRY':
      groupRegistry.dumpRegistry();
      return { success: true, message: 'Registry dumped to console' };
      
    case 'GET_GROUPING_INFO':
      return {
        stats: groupingEngine.getStats(),
        registryStats: groupRegistry.getStats(),
        lastActive: lastActiveCache.getAll()
      };
      
    case 'DUMP_GROUPING':
      groupingEngine.dumpState();
      return { success: true, message: 'Grouping state dumped to console' };
      
    case 'FORCE_REGROUP':
      await groupingEngine.planAndExecuteGrouping('manual-debug');
      return { success: true, message: 'Regrouping executed' };
      
    case 'CLEAR_ALL_DATA':
      try {
        await chrome.storage.local.remove(['apps', 'branches']);
        logger.info(LogCategory.STORAGE, 'All app and branch data cleared');
        return { success: true, message: 'All app and branch data cleared' };
      } catch (error) {
        logger.error(LogCategory.STORAGE, 'Failed to clear app and branch data', error);
        return { success: false, error: 'Failed to clear data' };
      }
      
    case 'DEBUG_CUSTOM_DOMAIN':
      try {
        if (message.url) {
          const identity = await parseTabIdentity(message.url);
          return {
            success: true,
            identity,
            enabled: true,
            cacheStats: identityLastActiveCache.getStats()
          };
        } else {
          return { success: false, error: 'Missing url parameter' };
        }
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error)
        };
      }
      
    default:
      return { error: 'Unknown debug message type' };
  }
}

/**
 * Message handler for content scripts and debugging
 */
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  try {
    let response: any;
    
    switch (message.type) {
      case 'CS_READY':
        response = await handleContentScriptReady(message, sender);
        break;
        
      case 'URL_CHANGED':
        response = await handleUrlChange(message, sender);
        break;
        
      case 'TAB_VISIBLE':
        response = await handleTabVisible(message, sender);
        break;
        
      case 'GET_ACTIVE_GROUP_COLORS':
        try {
          const activeColors = await getActiveTabGroupColors();
          response = { success: true, activeColors: Array.from(activeColors) };
        } catch (error) {
          logger.error(LogCategory.MESSAGE, 'Failed to get active group colors', {
            error: getErrorMessage(error)
          });
          response = { success: false, activeColors: [], error: String(error) };
        }
        break;
        
      case 'GET_BRANCH_DATA':
        try {
          const branch = await storage.getBranch(message.appId, message.version);
          response = { success: true, branch: branch || null };
        } catch (error) {
          logger.error(LogCategory.MESSAGE, 'Failed to get branch data', {
            appId: message.appId,
            version: message.version,
            error: getErrorMessage(error)
          });
          response = {
            success: false,
            branch: null,
            error: getErrorMessage(error)
          };
        }
        break;
        
      case 'BRANCH_GROUP_COLOR':
        try {
          if (sender.tab?.id && message.groupColor) {
            await groupingEngine.setBranchColor(sender.tab.id, message.groupColor);
            response = { success: true };
          } else {
            response = { success: false, error: 'Missing tabId or groupColor' };
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          logger.error(LogCategory.MESSAGE, 'Failed to set branch group color', {
            tabId: sender.tab?.id,
            appId: message.appId,
            version: message.version,
            color: message.groupColor,
            error: errorMessage
          });
          response = { success: false, error: errorMessage };
        }
        break;
        
      case 'SET_GROUPING_ENABLED':
        await storage.updateSettings({ grouping: { enabled: message.enabled } });
        if (message.enabled) {
          await groupingEngine.planAndExecuteGrouping('setting-enabled');
        }
        response = { success: true, enabled: message.enabled };
        break;
        
      case 'GET_GROUPING_ENABLED':
        const enabled = await storage.isGroupingEnabled();
        response = { enabled };
        break;
        
      case 'GET_CUSTOM_DOMAIN_STATUS':
        try {
          const cacheStats = identityLastActiveCache.getStats();
          response = { success: true, enabled: true, cacheStats };
        } catch (error) {
          response = {
            success: false,
            error: getErrorMessage(error)
          };
        }
        break;
        
      case 'PING_TEST':
        response = { success: true, message: 'Service worker is responsive' };
        break;
        
      // Handle scraping messages
      case 'TRIGGER_IMMEDIATE_SCRAPE':
      case 'IMMEDIATE_SCRAPE_RESULT':
      case 'FORCE_SCRAPE':
        response = await handleScrapeMessage(message);
        break;
        
      // Handle debug messages
      case 'GET_REGISTRY_INFO':
      case 'DUMP_REGISTRY':
      case 'GET_GROUPING_INFO':
      case 'DUMP_GROUPING':
      case 'FORCE_REGROUP':
      case 'CLEAR_ALL_DATA':
      case 'DEBUG_CUSTOM_DOMAIN':
        response = await handleDebugMessage(message, sender);
        break;
        
        
      default:
        response = { error: 'Unknown message type' };
    }
    
    sendResponse(response);
  } catch (error) {
    logger.error(LogCategory.MESSAGE, 'Message handler error', {
      messageType: message.type,
      error: getErrorMessage(error)
    });
    sendResponse({ error: 'Internal error processing message' });
  }
  
  return true; // Async response
});

/**
 * Ensure initialization on first event
 */
self.addEventListener('activate', () => {
  logger.info(LogCategory.INIT, 'Service worker activated');
  initialize().catch((error) => {
    logger.error(LogCategory.INIT, 'Failed to initialize on activate', error);
  });
});

// Cleanup on service worker termination
self.addEventListener('beforeunload', () => {
  logger.info(LogCategory.INIT, 'Service worker terminating, cleaning up resources');
  cleanupManager.cleanup();
});


/**
 * Create context menu items
 */
async function createContextMenus() {
  try {
    // Remove all existing context menus first
    await chrome.contextMenus.removeAll();
    
    // Create debug_mode toggle (will be shown/hidden based on current tab)
    chrome.contextMenus.create({
      id: 'toggle-debug-mode',
      title: 'Toggle debug_mode',
      contexts: ['all'],
      visible: false // Start hidden, will be shown when appropriate
    });
    
    // Create issues_off toggle (will be shown/hidden based on current tab)
    chrome.contextMenus.create({
      id: 'toggle-issues-off',
      title: 'Toggle issues_off',
      contexts: ['all'],
      visible: false // Start hidden, will be shown when appropriate
    });
    
    
    logger.info(LogCategory.INIT, 'Context menus created');
  } catch (error) {
    logger.error(LogCategory.INIT, 'Failed to create context menus', error);
  }
}

/**
 * Update context menu visibility and checked state based on current tab
 */
async function updateContextMenus(tabId: number) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) {
      // Hide both menus if no URL
      await chrome.contextMenus.update('toggle-debug-mode', { visible: false });
      await chrome.contextMenus.update('toggle-issues-off', { visible: false });
      return;
    }
    
    const url = new URL(tab.url);
    const params = url.searchParams;
    
    // Parse identity to determine page type
    const identity = await parseTabIdentity(tab.url);
    
    // Editors: ONLY bubble.io/page or *.bubble.is/page with id parameter
    const isEditor = identity?.type === 'editor';
    
    // Preview tabs: Identified by parseTabIdentity as preview type
    // This includes bubbleapps.io domains and validated custom domains
    const isPreview = identity?.type === 'preview';
    
    
    
    // Update debug_mode toggle - only show on preview tabs
    const debugMode = params.get('debug_mode') === 'true';
    await chrome.contextMenus.update('toggle-debug-mode', {
      title: debugMode ? 'Disable Debug Mode (On)' : 'Enable Debug Mode (Off)',
      visible: isPreview
    });
    
    // Update issues_off toggle - only show on editor tabs
    const issuesOff = params.get('issues_off') === 'true';
    await chrome.contextMenus.update('toggle-issues-off', {
      title: issuesOff ? 'Enable Issue Checker (Off)' : 'Disable Issue Checker (On)',
      visible: isEditor
    });
    
    
  } catch (error) {
    // Silently fail - tab might have been closed
  }
}

/**
 * Toggle URL parameter
 */
function toggleUrlParameter(url: string, param: string): string {
  const urlObj = new URL(url);
  const currentValue = urlObj.searchParams.get(param);
  
  if (currentValue === 'true') {
    // If it's true, remove it
    urlObj.searchParams.delete(param);
  } else if (currentValue === 'false' || currentValue === null) {
    // If it's false or missing, set to true
    urlObj.searchParams.set(param, 'true');
  }
  
  return urlObj.toString();
}


