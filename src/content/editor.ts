import { parseAndComputeTitle } from '../lib/url-parser';
import { attemptWithRetries, setupVisibilityListener, debugPageStructure } from './scraper';
import { logger, LogCategory } from '../lib/logger';
import { parseTabIdentitySync, isEditorUrl, isPreviewUrl } from '../lib/identity';
import { TIMING } from '../lib/constants';


interface CachedIconData {
  originalSvg: string;
  tabIconColor: string;
  tabBackgroundColor: string;
  isSelected: boolean;
}

interface BranchMetadata {
  appId: string;
  version: string;
  displayName?: string;
  chromeGroupColor?: string; // Chrome tab group color for this branch
  lastUpdated: number;
}

let currentFaviconSvg: string | null = null;
const iconCache: Map<string, CachedIconData> = new Map();
const branchMetadata: Map<string, BranchMetadata> = new Map(); // Store branch metadata
let cacheInitialized = false;

function getCurrentAppContext(): { appId?: string; version?: string } {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const appId = urlParams.get('id') || undefined;
    const version = urlParams.get('version') || 'test';
    
    return { appId, version };
  } catch (error) {
    return {};
  }
}

function generateCacheKey(tabName: string, appId?: string, version?: string): string {
  // Create a unique cache key that includes app and branch context
  const parts = [tabName];
  
  if (appId) {
    parts.push(appId);
  }
  
  if (version && version !== 'test') {
    parts.push(version);
  }
  
  return parts.join('::');
}

function generateBranchKey(appId?: string, version?: string): string {
  // Create a unique key for branch metadata
  const parts = [];
  
  if (appId) {
    parts.push(appId);
  }
  
  if (version) {
    parts.push(version);
  } else {
    parts.push('test'); // Default version
  }
  
  return parts.join('::');
}



async function getChromeGroupColorForCurrentBranch(): Promise<string | null> {
  const { appId, version } = getCurrentAppContext();
  if (!appId) return null;
  
  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Message timeout after 2 seconds'));
      }, TIMING.MESSAGE_TIMEOUT);
      
      chrome.runtime.sendMessage({
        type: 'GET_BRANCH_DATA',
        appId,
        version: version || 'test'
      }, (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    if (response && (response as any).success && (response as any).branch) {
      return (response as any).branch.color || null;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}







async function notifyServiceWorkerGroupColor(color?: string): Promise<void> {
  try {
    const { appId, version } = getCurrentAppContext();
    if (!appId) return;
    
    // Add delay to ensure service worker has processed the tab first
    if (!color) {
      await new Promise(resolve => setTimeout(resolve, TIMING.GROUP_COLOR_DELAY));
    }
    
    const groupColor = color || await getChromeGroupColorForCurrentBranch();
    
    // Only notify if we have a color to set
    if (!groupColor) {
      return;
    }
    
    await chrome.runtime.sendMessage({
      type: 'BRANCH_GROUP_COLOR',
      appId,
      version: version || 'test',
      groupColor,
      url: window.location.href
    });
  } catch (error) {
    // Silent fail
  }
}


function normalizeTabName(name: string): string {
  // Normalize tab names to handle variations
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractIconData(svgElement: SVGElement, button?: Element | null): CachedIconData {
  // Extract colors and original SVG without any color modifications
  let tabIconColor = '#333333'; // Default
  let tabBackgroundColor = '#f5f5f5'; // Default
  let isSelected = false;
  
  if (button) {
    isSelected = button.classList.contains('selected');
    
    // Get the computed colors directly from the original elements
    const svgStyles = window.getComputedStyle(svgElement);
    const buttonStyles = window.getComputedStyle(button);
    
    const svgColor = svgStyles.color;
    const bgColor = buttonStyles.backgroundColor;
    
    // Store the original tab colors
    if (svgColor && svgColor !== 'rgba(0, 0, 0, 0)' && svgColor !== 'transparent') {
      tabIconColor = svgColor;
    } else if (isSelected) {
      tabIconColor = 'rgb(12, 41, 171)'; // Bubble's selected blue
    }
    
    if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
      tabBackgroundColor = bgColor;
    } else if (isSelected) {
      tabBackgroundColor = 'rgb(235, 243, 255)'; // Bubble's selected background
    }
  }
  
  // Clone and prepare the original SVG (no color changes yet)
  const clonedSvg = svgElement.cloneNode(true) as SVGElement;
  
  return {
    originalSvg: clonedSvg.outerHTML,
    tabIconColor,
    tabBackgroundColor,
    isSelected
  };
}

function generateFaviconFromCache(cachedData: CachedIconData): string {
  // Create SVG from cached data
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = cachedData.originalSvg;
  const clonedSvg = tempDiv.firstElementChild as SVGElement;
  
  if (!clonedSvg) {
    return '';
  }
  
  // Detect user's theme preference for adaptive coloring
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  // Choose icon color based on theme and cached colors
  let iconColor: string;
  
  if (prefersDark) {
    // Dark theme: use lighter color (tab background) for better visibility
    iconColor = cachedData.tabBackgroundColor;
  } else {
    // Light theme: use the reversed color (tab background) for contrast
    iconColor = cachedData.tabBackgroundColor;
  }
  
  // Fallback for better visibility
  if (!iconColor || iconColor === 'rgba(0, 0, 0, 0)' || iconColor === 'transparent') {
    iconColor = prefersDark ? '#ffffff' : '#333333';
  }
  
  // Get the original viewBox to preserve aspect ratio
  const originalViewBox = clonedSvg.getAttribute('viewBox') || '0 0 24 24';
  
  // Set the SVG to fill the entire favicon area with transparent background
  clonedSvg.setAttribute('width', '32');
  clonedSvg.setAttribute('height', '32');
  clonedSvg.setAttribute('viewBox', originalViewBox);
  clonedSvg.style.backgroundColor = 'transparent';
  
  // Scale the icon to be as large as possible while maintaining aspect ratio
  const viewBoxParts = originalViewBox.split(' ');
  if (viewBoxParts.length === 4) {
    const vbWidth = parseFloat(viewBoxParts[2]);
    const vbHeight = parseFloat(viewBoxParts[3]);
    const scale = Math.min(32 / vbWidth, 32 / vbHeight) * 0.9; // 90% to leave small padding
    
    // Center and scale the content
    const translateX = (32 - vbWidth * scale) / 2;
    const translateY = (32 - vbHeight * scale) / 2;
    
    // Wrap all content in a group with transform
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('transform', `translate(${translateX}, ${translateY}) scale(${scale})`);
    
    // Move all existing children to the group
    while (clonedSvg.firstChild) {
      group.appendChild(clonedSvg.firstChild);
    }
    
    // Set new viewBox and add the scaled group
    clonedSvg.setAttribute('viewBox', '0 0 32 32');
    clonedSvg.appendChild(group);
  }
  
  // Update path colors with dynamic color
  const paths = clonedSvg.querySelectorAll('path');
  paths.forEach(path => {
    const currentFill = path.getAttribute('fill');
    if (!currentFill || currentFill === 'currentColor' || currentFill === 'none') {
      path.setAttribute('fill', iconColor);
    }
  });
  
  return clonedSvg.outerHTML;
}

function cacheAllSidebarIcons(): boolean {
  try {
    const sidebar = document.querySelector('.main-tab-bar');
    if (!sidebar) return false;

    const tabButtons = sidebar.querySelectorAll('button[data-tab-item], button[aria-label]');
    if (tabButtons.length === 0) return false;
    
    let cachedCount = 0;
    
    tabButtons.forEach((button, index) => {
      try {
        const dataTabItem = button.getAttribute('data-tab-item');
        const ariaLabel = button.getAttribute('aria-label');
        const tabName = dataTabItem || ariaLabel || `tab-${index}`;
        
        const svgElement = button.querySelector('svg');
        if (svgElement) {
          const iconData = extractIconData(svgElement, button);
          const { appId, version } = getCurrentAppContext();
          
          const cacheKey = generateCacheKey(tabName, appId, version);
          iconCache.set(cacheKey, iconData);
          
          if (dataTabItem && ariaLabel && dataTabItem !== ariaLabel) {
            const altCacheKey = generateCacheKey(ariaLabel, appId, version);
            iconCache.set(altCacheKey, iconData);
          }
          
          cachedCount++;
        }
      } catch (error) {
        // Silent continue
      }
    });
    
    if (cachedCount > 0) {
      cacheInitialized = true;
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

function getCurrentTabFromUrl(): { tabName: string; normalizedName: string } | null {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const tabFromUrl = urlParams.get('tab') || 'Design';
    
    return {
      tabName: tabFromUrl,
      normalizedName: normalizeTabName(tabFromUrl)
    };
  } catch (error) {
    return null;
  }
}

function getIconFromCache(tabName: string): string | null {
  const safeTabName = String(tabName || 'Design');
  const { appId, version } = getCurrentAppContext();
  const cacheKey = generateCacheKey(safeTabName, appId, version);
  
  // Try branch-specific match first
  if (iconCache.has(cacheKey)) {
    const cachedData = iconCache.get(cacheKey)!;
    return generateFaviconFromCache(cachedData);
  }
  
  // Fallback to tab-only key for backward compatibility
  if (iconCache.has(safeTabName)) {
    const cachedData = iconCache.get(safeTabName)!;
    return generateFaviconFromCache(cachedData);
  }
  
  // If cache is initialized but missing the tab, try to rebuild cache and retry once
  if (cacheInitialized) {
    // Rebuild cache and try again
    cacheAllSidebarIcons();
    
    // Retry after rebuild
    if (iconCache.has(cacheKey)) {
      const cachedData = iconCache.get(cacheKey)!;
      return generateFaviconFromCache(cachedData);
    }
    
    if (iconCache.has(safeTabName)) {
      const cachedData = iconCache.get(safeTabName)!;
      return generateFaviconFromCache(cachedData);
    }
  }
  
  return null;
}

function extractTabSvg(): { svg: string; tabName: string } | null {
  // Get current tab from URL parameter
  const tabInfo = getCurrentTabFromUrl();
  if (!tabInfo) {
    return null;
  }
  
  const { tabName, normalizedName } = tabInfo;
  
  // Try to get from cache first
  const cachedSvg = getIconFromCache(tabName);
  if (cachedSvg) {
    return { svg: cachedSvg, tabName };
  }
  
  // Fallback: extract from DOM by finding the tab button
  // Always try DOM extraction if cache lookup failed
  
  try {
    // Find the specific tab button by its data-tab-item or aria-label
    const safeTabNameForQuery = String(tabName || 'Design');
    const tabButton = document.querySelector(
      `.main-tab-bar button[data-tab-item="${safeTabNameForQuery}"], .main-tab-bar button[aria-label="${safeTabNameForQuery}"]`
    );
    
    if (!tabButton) {
      return null;
    }
    
    const svgElement = tabButton.querySelector('svg');
    if (!svgElement) {
      return null;
    }
    
    const iconData = extractIconData(svgElement, tabButton);
    const processedSvg = generateFaviconFromCache(iconData);
    const { appId, version } = getCurrentAppContext();
    
    // Cache it with branch-specific keys
    const cacheKey = generateCacheKey(tabName, appId, version);
    const normalizedCacheKey = generateCacheKey(normalizedName, appId, version);
    
    iconCache.set(cacheKey, iconData);
    iconCache.set(normalizedCacheKey, iconData);
    
    return { svg: processedSvg, tabName };
  } catch (error) {
    return null;
  }
}

function svgToFaviconDataUrl(svgString: string): string {
  const encodedSvg = encodeURIComponent(svgString);
  return `data:image/svg+xml,${encodedSvg}`;
}

function updateFaviconFromSelectedTab(): void {
  try {
    const result = extractTabSvg();
    if (!result) return;
    
    const { svg } = result;
    if (currentFaviconSvg === svg) return;
    
    const faviconUrl = svgToFaviconDataUrl(svg);
    
    let faviconLink = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    
    if (!faviconLink) {
      faviconLink = document.createElement('link');
      faviconLink.rel = 'icon';
      faviconLink.type = 'image/svg+xml';
      document.head.appendChild(faviconLink);
    }
    
    faviconLink.href = faviconUrl;
    currentFaviconSvg = svg;
  } catch (error) {
    // Silent fail
  }
}

function getFaviconStatus(): { 
  currentSvg: string | null; 
  currentTab: string | null;
  cacheInitialized: boolean;
  cacheSize: number;
  cacheKeys: string[];
} {
  const tabInfo = getCurrentTabFromUrl();
  return {
    currentSvg: currentFaviconSvg,
    currentTab: tabInfo?.tabName || null,
    cacheInitialized,
    cacheSize: iconCache.size,
    cacheKeys: Array.from(iconCache.keys())
  };
}

function forceUpdateFavicon(): void {
  currentFaviconSvg = null;
  updateFaviconFromSelectedTab();
}

function clearIconCache(): void {
  iconCache.clear();
  cacheInitialized = false;
  currentFaviconSvg = null;
}

// Listen for theme changes to update favicon colors dynamically
function setupThemeListener(): void {
  if (window.matchMedia) {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleThemeChange = (e: MediaQueryListEvent) => {
      // Force favicon update when theme changes
      forceUpdateFavicon();
    };
    
    // Add listener for theme changes
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleThemeChange);
    } else {
      // Fallback for older browsers
      mediaQuery.addListener(handleThemeChange);
    }
  }
}

function rebuildIconCache(): boolean {
  clearIconCache();
  const success = cacheAllSidebarIcons();
  if (success) {
    updateFaviconFromSelectedTab();
  }
  return success;
}


// Prevent multiple script execution - check and exit immediately
if ((window as any).__btmContentScriptLoaded) {
  // Exit silently for duplicate instances
} else {
  (window as any).__btmContentScriptLoaded = true;

// Only execute the rest of the script if this is the first instance


// Build info
const BUILD_INFO = {
  version: '1.0.0',
  env: process.env.NODE_ENV || 'production',
  timestamp: new Date().toISOString(),
};

class TitleManager {
  private currentUrl = '';
  private currentTitle = '';
  private retryTimeouts: number[] = [];
  private devLogging = false;
  private retryDelays = [250, 750, 1500]; // Brief retry schedule
  
  constructor() {
    this.init();
  }

  private async init() {
    // Check if dev logging is enabled
    try {
      const result = await chrome.storage.local.get('devLogging');
      this.devLogging = result.devLogging === true || BUILD_INFO.env === 'development';
    } catch {
      this.devLogging = BUILD_INFO.env === 'development';
    }


    // Log initialization with build info
    logger.info(LogCategory.CONTENT, 'Editor content script initialized', {
      url: window.location.href,
      buildInfo: BUILD_INFO
    });
    
    // Set up event listeners for navigation detection
    this.setupNavigationListeners();
    
    // Set up tab change detection for favicon updates
    this.setupTabChangeDetection();
    
    // Initialize icon cache first to avoid timing issues
    this.initializeIconCache();
    
    // Send ready message to service worker
    this.sendMessage({ type: 'CS_READY', url: window.location.href });
    
    // Notify service worker of Chrome group color for current branch
    setTimeout(() => {
      notifyServiceWorkerGroupColor();
    }, 200);
    
    // Update title and favicon after cache initialization
    setTimeout(() => {
      this.updateTitle(true);
    }, 100);
    
    // Trigger immediate scraping and group update
    setTimeout(() => {
      this.triggerImmediateUpdate();
    }, TIMING.IMMEDIATE_UPDATE_DELAY);

    // Setup visibility listener for scraping trigger
    setupVisibilityListener(() => {
      this.sendMessage({
        type: 'TAB_VISIBLE',
        url: window.location.href,
        identity: parseTabIdentitySync(window.location.href)
      });
    });

    // Add debug functions only in development mode
    if (BUILD_INFO.env === 'development' || this.devLogging) {
      (window as any).testScraping = async () => {
        const result = await attemptWithRetries();
        return result;
      };
      (window as any).debugPageStructure = debugPageStructure;
      (window as any).rebuildIconCache = rebuildIconCache;
      (window as any).clearIconCache = clearIconCache;
    }
  }

  private setupNavigationListeners() {
    // Listen for custom URL change events from MAIN-world script
    window.addEventListener('btm:urlchange', (event) => {
      const detail = (event as CustomEvent).detail;
      this.log(`URL changed via ${detail.method}`, {
        url: detail.url,
        timestamp: detail.timestamp
      });
      this.onUrlChange(`main-${detail.method}`);
    });
    
    // Listen to browser navigation events (fallback + additional coverage)
    window.addEventListener('popstate', () => {
      this.log('Navigation event: popstate');
      this.onUrlChange('popstate');
    });
    
    window.addEventListener('hashchange', () => {
      this.log('Navigation event: hashchange');
      this.onUrlChange('hashchange');
    });
    
    // Check URL when tab becomes visible (user switches back)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.log('Navigation event: visibilitychange (tab visible)');
        this.onUrlChange('visibilitychange');
      }
    });

    // Conditional polling fallback
    this.setupConditionalPolling();
    
  }

  private setupConditionalPolling() {
    let lastUrl = window.location.href;
    let pollingActive = false;
    let pollingInterval: number | null = null;
    let mainWorldEventsSeen = false;
    
    // Check for MAIN-world hook confirmation
    const checkMainWorldHook = () => {
      return (window as any).__btmMainWorldInstalled === true;
    };
    
    // Start polling if needed
    const startPolling = (reason: string) => {
      if (pollingActive) return;
      pollingActive = true;
      
      pollingInterval = window.setInterval(() => {
        if (window.location.href !== lastUrl) {
          this.log('URL changed via conditional polling', {
            from: lastUrl,
            to: window.location.href
          });
          lastUrl = window.location.href;
          this.onUrlChange('conditional-polling');
        }
      }, 1000);
      
        // Auto-stop after 30 seconds
      setTimeout(() => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
          pollingActive = false;
        }
      }, 30000);
    };
    
    // Stop polling when MAIN-world events are confirmed
    const stopPolling = () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        pollingActive = false;
      }
    };
    
    // Listen for MAIN-world events to confirm they're working
    const originalMainEventListener = window.addEventListener('btm:urlchange', () => {
      if (!mainWorldEventsSeen) {
        mainWorldEventsSeen = true;
        stopPolling();
      }
    });
    
    // Start polling if MAIN-world hooks not detected
    setTimeout(() => {
      if (!checkMainWorldHook() || !mainWorldEventsSeen) {
        startPolling('MAIN-world hooks not confirmed');
      }
    }, 2000);
    
    // Store cleanup function
    (this as any).cleanupPolling = () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }

  private log(message: string, data?: any) {
    logger.debug(LogCategory.CONTENT, message, data);
  }

  private async onUrlChange(trigger: string) {
    const newUrl = window.location.href;
    
    if (newUrl !== this.currentUrl) {
      this.log(`URL changed via ${trigger}`, { 
        from: this.currentUrl || 'initial', 
        to: newUrl 
      });
      this.currentUrl = newUrl;
      
      this.updateTitle(true);
      
      // Notify service worker of URL change to trigger scraping
      this.sendMessage({
        type: 'URL_CHANGED',
        url: newUrl,
        trigger: trigger
      });
      
      // Notify service worker of Chrome group color for new branch
      notifyServiceWorkerGroupColor();
    }
  }

  private updateTitle(withRetries = false) {
    const url = window.location.href;
    const newTitle = parseAndComputeTitle(url);
    
    if (!newTitle) {
      return;
    }
    
    // Avoid no-op updates to prevent tug-of-war
    if (document.title === newTitle) {
      // Still update favicon even if title is same (selected tab may have changed)
      this.updateFavicon();
      return;
    }
    
    // Clear any pending retries
    this.clearRetries();
    
    // Apply title
    this.applyTitle(newTitle);
    
    // Update favicon for selected tab
    this.updateFavicon();
    
    // Schedule retries if requested (to handle Bubble overwrites)
    if (withRetries) {
      this.scheduleRetries(newTitle);
    }
  }

  private applyTitle(title: string) {
    const oldTitle = document.title;
    document.title = title;
    this.currentTitle = title;
    
    this.log('Title updated', { 
      from: oldTitle, 
      to: title,
      url: window.location.href 
    });
  }

  private scheduleRetries(expectedTitle: string) {
    this.retryDelays.forEach((delay, index) => {
      const timeoutId = window.setTimeout(() => {
        // Only retry if the title was changed by someone else
        if (document.title !== expectedTitle) {
          this.applyTitle(expectedTitle);
        }
      }, delay);
      
      this.retryTimeouts.push(timeoutId);
    });
  }

  private clearRetries() {
    if (this.retryTimeouts.length > 0) {
      this.retryTimeouts.forEach(id => window.clearTimeout(id));
      this.retryTimeouts = [];
    }
  }

  private initializeIconCache() {
    
    const attemptCache = (attempts = 0) => {
      const maxAttempts = 3;
      
      if (attempts >= maxAttempts) {
        return;
      }
      
      const sidebar = document.querySelector('.main-tab-bar');
      if (!sidebar) {
        setTimeout(() => attemptCache(attempts + 1), 1000);
        return;
      }
      
      const tabButtons = sidebar.querySelectorAll('button[data-tab-item], button[aria-label]');
      if (tabButtons.length === 0) {
        setTimeout(() => attemptCache(attempts + 1), 1000);
        return;
      }
      
      // Cache the icons
      const success = cacheAllSidebarIcons();
      
      if (success) {
        this.updateFavicon();
      } else {
        setTimeout(() => attemptCache(attempts + 1), 1000);
      }
    };
    
    attemptCache();
  }

  private updateFavicon() {
    try {
      updateFaviconFromSelectedTab();
    } catch (error) {
      // Continue silently
    }
  }

  private setupTabChangeDetection() {
    // Set up a MutationObserver to detect when the selected tab changes
    const sidebarObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check if the selected class was added/removed from any tab
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const target = mutation.target as Element;
          if (target.matches('.main-tab-bar button')) {
            // A tab button's class changed, update favicon
            this.updateFavicon();
            break;
          }
        }
      }
    });

    // Start observing when the sidebar is available
    const startObserving = () => {
      const sidebar = document.querySelector('.main-tab-bar');
      if (sidebar) {
        sidebarObserver.observe(sidebar, {
          attributes: true,
          subtree: true,
          attributeFilter: ['class']
        });
        return true;
      }
      return false;
    };

    // Try to start observing immediately, or wait for sidebar to load
    if (!startObserving()) {
      // Wait for document.body to be available
      const setupDocumentObserver = () => {
        if (!document.body) {
          // If body is not ready, wait a bit and try again
          setTimeout(setupDocumentObserver, 100);
          return;
        }
        
        const documentObserver = new MutationObserver(() => {
          if (startObserving()) {
            documentObserver.disconnect();
          }
        });
        
        try {
          documentObserver.observe(document.body, {
            childList: true,
            subtree: true
          });
          
          // Stop trying after timeout
          setTimeout(() => {
            documentObserver.disconnect();
          }, 10000);
        } catch (error) {
          // Continue silently
        }
      };
      
      setupDocumentObserver();
    }
  }

  private async sendMessage(message: any) {
    try {
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      // Service worker might not be ready yet
      logger.debug(LogCategory.CONTENT, 'Failed to send message', { message, error });
    }
  }

  private async triggerImmediateUpdate() {
    this.log('Triggering immediate scraping and group update');
    
    try {
      // 1. Check if this is an editor page - only scrape on editor pages
      const currentUrl = window.location.href;
      const isEditor = isEditorUrl(currentUrl);
      
      
      if (!isEditor) {
        return;
      }
      
      // 2. Trigger scraping for this tab
      const identity = parseTabIdentitySync(currentUrl);
      if (identity && identity.type === 'editor') {
        this.sendMessage({
          type: 'TRIGGER_IMMEDIATE_SCRAPE',
          appId: identity.appId,
          versionId: identity.versionId,
          url: currentUrl
        });
      }
      
      // 3. Also manually scrape and send result
      try {
        const branchName = await attemptWithRetries();
        if (branchName) {
          this.sendMessage({
            type: 'IMMEDIATE_SCRAPE_RESULT',
            appId: identity?.appId,
            versionId: identity?.versionId,
            branchName: branchName,
            url: currentUrl
          });
        }
      } catch (scrapeError) {
        // Continue silently
      }
      
    } catch (error) {
      // Continue silently
    }
  }

  private async handleScrapeBranchName(message: any, sendResponse: (response: any) => void) {
    
    // Use setTimeout to ensure async response works properly
    setTimeout(async () => {
      try {
        // Check if this is an editor page first
        const currentUrl = window.location.href;
        const isEditor = isEditorUrl(currentUrl);
        
        if (!isEditor) {
          const response = { 
            success: false, 
            error: 'Branch name scraping only available on editor pages',
            pageType: 'preview',
            url: currentUrl
          };
          sendResponse(response);
          return;
        }
        
        const branchName = await attemptWithRetries();
        const response = { 
          success: true, 
          branchName,
          timestamp: Date.now(),
          pageType: 'editor'
        };
        sendResponse(response);
      } catch (error) {
        const response = { 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error',
          errorType: typeof error,
          stack: error instanceof Error ? error.stack : undefined
        };
        sendResponse(response);
      }
    }, 10);
  }

  /**
   * Handle basic info request messages
   */
  private handleInfoMessage(message: any): { response: any; isAsync: boolean } {
    switch (message.type) {
      case 'PING':
        return { response: { type: 'PONG', timestamp: Date.now() }, isAsync: false };
        
      case 'GET_URL':
        return { response: { url: window.location.href }, isAsync: false };
        
      case 'GET_TITLE_INFO':
        return {
          response: {
            currentUrl: window.location.href,
            currentTitle: document.title,
            computedTitle: parseAndComputeTitle(window.location.href),
            mainWorldInstalled: (window as any).__btmMainWorldInstalled === true,
            mainWorldMethods: (window as any).__btmMainWorldMethods || null
          },
          isAsync: false
        };
        
      case 'GET_IDENTITY_INFO':
        const identity = parseTabIdentitySync(window.location.href);
        return {
          response: {
            url: window.location.href,
            identity: identity,
            isEditor: isEditorUrl(window.location.href),
            isPreview: isPreviewUrl(window.location.href)
          },
          isAsync: false
        };
        
      default:
        return { response: null, isAsync: false };
    }
  }

  /**
   * Handle favicon-related messages
   */
  private handleFaviconMessage(message: any): { response: any; isAsync: boolean } {
    switch (message.type) {
      case 'GET_FAVICON_STATUS':
        const faviconStatus = getFaviconStatus();
        return {
          response: {
            success: true,
            currentSvg: faviconStatus.currentSvg,
            currentTab: faviconStatus.currentTab,
            cacheInitialized: faviconStatus.cacheInitialized,
            cacheSize: faviconStatus.cacheSize,
            cacheKeys: faviconStatus.cacheKeys,
            sidebarPresent: !!document.querySelector('.main-tab-bar')
          },
          isAsync: false
        };
        
      case 'FORCE_UPDATE_FAVICON':
        forceUpdateFavicon();
        return { response: { success: true, message: 'Favicon update forced' }, isAsync: false };
        
      case 'REBUILD_ICON_CACHE':
        rebuildIconCache();
        return { response: { success: true, message: 'Icon cache rebuilt' }, isAsync: false };
        
      case 'CLEAR_ICON_CACHE':
        clearIconCache();
        return { response: { success: true, message: 'Icon cache cleared' }, isAsync: false };
        
      default:
        return { response: null, isAsync: false };
    }
  }

  // Message handler for service worker communication
  public handleMessage(message: any, sender: any, sendResponse: (response: any) => void): boolean {
    this.log('Message received', { type: message.type });

    // Try info messages first
    const infoResult = this.handleInfoMessage(message);
    if (infoResult.response) {
      sendResponse(infoResult.response);
      return infoResult.isAsync;
    }

    // Try favicon messages
    const faviconResult = this.handleFaviconMessage(message);
    if (faviconResult.response) {
      sendResponse(faviconResult.response);
      return faviconResult.isAsync;
    }

    // Handle remaining message types
    switch (message.type) {
      case 'UPDATE_TITLE':
        this.updateTitle();
        sendResponse({ success: true });
        return false;
        
      case 'SCRAPE_BRANCH_NAME':
        this.handleScrapeBranchName(message, sendResponse);
        return true; // Async response
        
      default:
        sendResponse({ error: 'Unknown message type' });
        return false;
    }
  }
}

// Initialize title manager
let titleManager: TitleManager;
let initialized = false;

// Set up global message listener to handle duplicate script scenarios
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If this is a skip execution instance, create a minimal handler
  if ((window as any).__btmSkipExecution) {
    // Handle basic ping to prevent scraping failures
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG', timestamp: Date.now(), source: 'duplicate' });
      return false;
    }
    
    // For other messages, indicate script is not ready
    sendResponse({ error: 'Duplicate script instance, main script should handle' });
    return false;
  }
  
  // If titleManager exists, delegate to it
  if (titleManager) {
    const isAsync = titleManager.handleMessage(message, sender, sendResponse);
    return isAsync;
  }
  
  // If titleManager doesn't exist yet, handle basic messages
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG', timestamp: Date.now(), ready: false });
    return false;
  }
  
  sendResponse({ error: 'Content script initializing' });
  return false;
});

function init() {
  // Check if this script instance should skip execution
  if ((window as any).__btmSkipExecution) {
    return;
  }
  
  // Prevent multiple initialization
  if (initialized) {
    return;
  }
  
  logger.info(LogCategory.CONTENT, 'Initializing content script', {
    url: window.location.href,
    readyState: document.readyState,
    timestamp: Date.now()
  });
  
  titleManager = new TitleManager();
  initialized = true;
  
  // Setup theme listener for adaptive favicon colors
  setupThemeListener();
  
  logger.info(LogCategory.CONTENT, 'Content script initialization complete');
}

// Initialize when DOM is ready or immediately if already loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Also try to initialize after a brief delay in case of timing issues
setTimeout(() => {
  if (!initialized) {
    init();
  }
}, 100);

// Close the conditional block for first instance execution
}