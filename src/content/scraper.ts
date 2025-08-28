interface ScrapeResult {
  branchName: string | null;
  timestamp: number;
}

interface ScrapeOptions {
  maxAttempts?: number;
  delays?: number[];
  timeBudgetMs?: number;
}

// Cache DOM queries for performance
let cachedContainers: Element[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5 seconds


/**
 * Get cached container elements or query and cache them
 */
function getCachedContainers(): Element[] {
  const now = Date.now();
  if (cachedContainers && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedContainers;
  }
  
  // Query and cache containers
  const containers: Element[] = [];
  
  // Use a single query with comma-separated selectors for efficiency
  const commonContainers = document.querySelectorAll(
    'header, nav, [role="navigation"], .header, .toolbar, .topbar, .navbar, ' +
    '.bubble-element, [class*="version"], [class*="branch"], [class*="dropdown"]'
  );
  containers.push(...commonContainers);
  
  cachedContainers = containers;
  cacheTimestamp = now;
  return containers;
}

/**
 * Enhanced debugging function to analyze the page structure
 */
export function debugPageStructure(): any {
  const analysis = {
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    dropdownCandidates: [] as any[],
    slashContainingElements: [] as any[],
    headerElements: [] as any[]
  };
  
  // Use cached containers for efficient querying
  const containers = getCachedContainers();
  
  // Find elements with slash patterns
  for (const container of containers) {
    const textElements = container.querySelectorAll('span, div, button, a, [class*="text"]');
    for (const elem of textElements) {
      const text = elem.textContent?.trim();
      if (text && text.includes('/') && text.length < 200 && text.length > 3) {
        analysis.slashContainingElements.push({
          tagName: elem.tagName,
          className: elem.className || '',
          text: text.substring(0, 100),
          id: elem.id || '',
          parent: elem.parentElement?.tagName || ''
        });
      }
      if (analysis.slashContainingElements.length >= 20) break;
    }
    if (analysis.slashContainingElements.length >= 20) break;
  }
  
  // Process header elements
  for (const header of containers) {
    if (header.matches('header, nav, [role="navigation"], .header, .toolbar, .topbar, .navbar')) {
      analysis.headerElements.push({
        tagName: header.tagName,
        className: header.className || '',
        textPreview: header.textContent?.trim().substring(0, 100) || '',
        id: header.id || ''
      });
    }
  }
  
  return analysis;
}

/**
 * Attempt to scrape branch name with retries
 */
export async function attemptWithRetries(options: ScrapeOptions = {}): Promise<string | null> {
  try {
    const {
      maxAttempts = 4,
      delays = [0, 250, 1000, 2000],
      timeBudgetMs = 200
    } = options;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Wait for delay (0ms on first attempt)
        if (attempt > 0 && delays[attempt - 1]) {
          await new Promise(resolve => setTimeout(resolve, delays[attempt - 1]));
        }
        
        // Try to scrape with time budget
        const result = await scrapeWithBudget(timeBudgetMs);
        if (result) {
          return result;
        }
      } catch (attemptError) {
        // Continue to next attempt
        continue;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Single scrape attempt with time budget
 */
async function scrapeWithBudget(timeBudgetMs: number): Promise<string | null> {
  const startTime = performance.now();
  
  // Primary strategy: versions dropdown
  const primary = tryPrimarySelector();
  if (primary) {
    return primary;
  }

  // Check time budget
  if (performance.now() - startTime > timeBudgetMs) {
    return null;
  }

  // Fallback strategy: search common containers
  const fallback = tryFallbackSearch(timeBudgetMs - (performance.now() - startTime));
  return fallback;
}

/**
 * Primary scraping strategy using versions dropdown
 */
function tryPrimarySelector(): string | null {
  let dropdown = null;
  let usedSelector = null;
  
  // Try global search first - this is more reliable
  const specificSelectors = [
    '[itemid="versions-dropdown"]',
    '[data-itemid="versions-dropdown"]',
    '.version-dropdown',
    '.branch-selector'
  ];

  // Try global document search first
  for (const selector of specificSelectors) {
    try {
      const elements = document.querySelectorAll(selector);
      
      for (const elem of elements) {
        const text = elem.textContent?.trim();
        if (text && text.includes('/') && text.length < 200) {
          dropdown = elem;
          usedSelector = selector;
          break;
        }
      }
      if (dropdown) break;
    } catch (e) {
      // Skip failed selectors
      continue;
    }
  }

  // If global search worked, parse and return the result
  if (dropdown) {
    const ariaLabel = dropdown.getAttribute('aria-label');
    const label = dropdown.getAttribute('label');
    const textContent = dropdown.textContent;
    
    const text = ariaLabel || label || textContent;
    if (text) {
      const result = parseBranchName(text);
      return result;
    }
    return null;
  }

  // Fallback to container search if global search failed
  const containers = getCachedContainers();

  // Search within containers first (more efficient)
  for (const container of containers) {
    for (const selector of specificSelectors) {
      try {
        const elements = container.querySelectorAll(selector);
        
        for (const elem of elements) {
          const text = elem.textContent?.trim();
          
          if (text && text.includes('/') && text.length < 200) {
            dropdown = elem;
            usedSelector = selector;
            break;
          }
        }
        if (dropdown) break;
      } catch (e) {
        continue;
      }
    }
    if (dropdown) break;
  }

  // If no specific selector worked, try broader search within containers
  if (!dropdown) {
    const broadSelectors = [
      '[class*="version"]',
      '[class*="branch"]',
      '[class*="dropdown"]'
    ];
    
    for (const container of containers) {
      for (const selector of broadSelectors) {
        try {
          const elements = container.querySelectorAll(selector);
          for (const elem of elements) {
            const text = elem.textContent?.trim();
            if (text && text.includes('/') && text.length < 100) {
              dropdown = elem;
              usedSelector = selector;
              break;
            }
          }
          if (dropdown) break;
        } catch (e) {
          continue;
        }
      }
      if (dropdown) break;
    }
  }
  
  if (!dropdown) {
    
    const candidates = [];
    
    // Use cached containers instead of querying again
    for (const container of containers) {
      try {
        // Look for text elements within this container - use single query with comma-separated selectors
        const textElements = container.querySelectorAll('span, div, button, a, [class*="text"]');
        for (const elem of textElements) {
          try {
            const text = elem.textContent?.trim();
            if (text && text.length < 100 && text.length > 2) {
              // Look for patterns like "something / something"
              if (/\w+\s*\/\s*\w+/.test(text)) {
                candidates.push({
                  element: elem,
                  text: text,
                  tagName: elem.tagName,
                  className: elem.className || '',
                  container: container.tagName
                });
              }
            }
          } catch (e) {
            continue;
          }
        }
        // Limit candidates to prevent performance issues
        if (candidates.length >= 20) break;
      } catch (e) {
        continue;
      }
    }
    
    // Try parsing each candidate
    for (const candidate of candidates) {
      const result = parseBranchName(candidate.text);
      if (result) {
        return result;
      }
    }
    
    return null;
  }

  // Priority: aria-label → label → textContent
  const ariaLabel = dropdown.getAttribute('aria-label');
  const label = dropdown.getAttribute('label');
  const textContent = dropdown.textContent;
  
  let text = ariaLabel || label || textContent;

  if (!text) {
    return null;
  }

  // Parse "parent / child" format
  const result = parseBranchName(text);
  return result;
}

/**
 * Fallback strategy: search likely containers
 */
function tryFallbackSearch(remainingBudgetMs: number): string | null {
  const startTime = performance.now();
  
  // Use cached containers instead of querying again
  const containers = getCachedContainers();
  
  // Limit to first 10 containers for performance
  const searchContainers = containers.slice(0, 10);
  
  for (const container of searchContainers) {
    // Check time budget
    if (performance.now() - startTime > remainingBudgetMs) {
      break;
    }

    const result = searchTextNodes(container, 100, remainingBudgetMs - (performance.now() - startTime));
    if (result) {
      return result;
    }
  }

  return null;
}

/**
 * Search text nodes within an element
 */
function searchTextNodes(element: Element, maxNodes: number, budgetMs: number): string | null {
  const startTime = performance.now();
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const text = node.textContent?.trim();
        if (!text || text.length < 3 || text.length > 100) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let nodesChecked = 0;
  let node: Node | null;
  
  while ((node = walker.nextNode()) && nodesChecked < maxNodes) {
    // Check time budget
    if (performance.now() - startTime > budgetMs) {
      break;
    }

    nodesChecked++;
    const text = node.textContent;
    if (text && /[\w-]+\s*\/\s*[\w-]+/.test(text)) {
      const parsed = parseBranchName(text);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Parse branch name from "parent / child" format
 */
function parseBranchName(text: string): string | null {
  // Clean up the text first
  const cleaned = text.trim().replace(/\s+/g, ' ');
  
  // Try different patterns
  // Pattern 1: "parent / child" format (like "Main / approval-custom-file" or "home-new / home-qa")
  let match = cleaned.match(/([^\/]+)\s*\/\s*([^\/]+)/);
  if (match) {
    const parent = match[1].trim();
    const child = match[2].trim();
    
    // Return the child part (branch name) - allow alphanumeric, hyphens, and underscores
    if (/^[\w-]+$/.test(child) && child.length > 1) {
      return child;
    }
    
    // If child doesn't match strict pattern, try a more lenient approach
    if (child.length > 1 && child.length < 50) {
      // Remove any extra characters and keep alphanumeric, hyphens, underscores
      const cleanChild = child.replace(/[^\w-]/g, '');
      if (cleanChild.length > 1) {
        return cleanChild;
      }
    }
  }
  
  // Pattern 2: Just look for anything after a slash (more lenient)
  match = cleaned.match(/\/\s*([^\s]+)/);
  if (match) {
    const branchName = match[1].replace(/[^\w-]/g, '');
    if (branchName.length > 1) {
      return branchName;
    }
  }
  
  // Pattern 3: If no slash, but it looks like a branch name
  if (/^[\w-]+$/.test(cleaned) && cleaned.length > 2 && cleaned.length < 50) {
    return cleaned;
  }
  
  return null;
}

/**
 * Listen for visibility changes to trigger scraping
 */
let visibilityListener: (() => void) | null = null;

export function setupVisibilityListener(callback: () => void): void {
  if (visibilityListener) {
    document.removeEventListener('visibilitychange', visibilityListener);
  }
  
  visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      callback();
    }
  };
  
  document.addEventListener('visibilitychange', visibilityListener);
}

/**
 * Clean up listeners and caches
 */
export function cleanup(): void {
  if (visibilityListener) {
    document.removeEventListener('visibilitychange', visibilityListener);
    visibilityListener = null;
  }
  
  // Clear DOM query cache
  cachedContainers = null;
  cacheTimestamp = 0;
}