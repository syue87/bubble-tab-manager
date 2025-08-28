import { storage } from './storage';
import { logger, LogCategory } from './logger';

export interface TabIdentity {
  appId: string;
  versionId: string;
  type: 'editor' | 'preview';
  hostname: string;
  tab?: string;
  name?: string;
}

export interface EditorIdentity extends TabIdentity {
  type: 'editor';
  tab: string;
  name?: string;
}

export interface PreviewIdentity extends TabIdentity {
  type: 'preview';
}

/**
 * Parse editor URL for identity
 * Supports: https://bubble.io/page* and https://*.bubble.is/page*
 */
export function parseEditorIdentity(url: string): EditorIdentity | null {
  try {
    const urlObj = new URL(url);
    
    // Check if it's an editor URL
    const isStandardEditor = urlObj.hostname === 'bubble.io' && urlObj.pathname === '/page';
    const isDedicatedEditor = urlObj.hostname.endsWith('.bubble.is') && urlObj.pathname === '/page';
    
    if (!isStandardEditor && !isDedicatedEditor) {
      return null;
    }
    
    // Extract parameters
    const params = urlObj.searchParams;
    const appId = params.get('id');
    const versionId = params.get('version') || 'test'; // Default to test
    const tab = params.get('tab') || 'Design';
    const name = params.get('name') || undefined;
    
    if (!appId) {
      return null; // Must have appId
    }
    
    return {
      appId: decodeURIComponent(appId),
      versionId: decodeURIComponent(versionId),
      type: 'editor',
      hostname: urlObj.hostname,
      tab: decodeURIComponent(tab),
      name: name ? decodeURIComponent(name) : undefined
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse preview URL for identity
 * Supports: https://<appId>.bubbleapps.io/... with optional /version-<id>
 */
export function parsePreviewIdentity(url: string): PreviewIdentity | null {
  try {
    const urlObj = new URL(url);
    
    // Check if it's a bubbleapps.io preview
    const bubbleMatch = urlObj.hostname.match(/^([^.]+)\.bubbleapps\.io$/);
    if (!bubbleMatch) {
      return null; // Not a bubbleapps preview
    }
    
    const appId = bubbleMatch[1];
    const pathname = urlObj.pathname;
    
    // Extract version from path using segment-safe regex
    const versionMatch = pathname.match(/(^|\/)version-([A-Za-z0-9_-]+)(\/|$)/);
    const versionId = versionMatch ? versionMatch[2] : 'live';
    
    return {
      appId: decodeURIComponent(appId),
      versionId: decodeURIComponent(versionId),
      type: 'preview',
      hostname: urlObj.hostname
    };
  } catch (error) {
    return null;
  }
}

/**
 * Find existing app for a given hostname by scanning baseUrls
 */
async function findAppByHostname(hostname: string): Promise<string | null> {
  try {
    const apps = await storage.getApps();
    
    for (const app of Object.values(apps)) {
      if (app.baseUrls && app.baseUrls.includes(hostname)) {
        return app.appId;
      }
    }
    
    return null;
  } catch (error) {
    // Log storage error but don't break custom domain detection
    logger.error(LogCategory.CUSTOM_DOMAIN, 'Storage error in findAppByHostname', {
      hostname,
      error: String(error)
    });
    return null;
  }
}

/**
 * Find existing app for a given version ID by scanning storage
 * Only map custom domains when we have existing app/version combination
 */
async function findExistingAppForVersion(versionId: string): Promise<string | null> {
  try {
    const branches = await storage.getBranches();
    
    // Search through all branches to find one with matching versionId
    for (const branch of Object.values(branches)) {
      if (branch.versionId === versionId) {
        return branch.appId;
      }
    }
    return null;
  } catch (error) {
    // Log storage error but don't break custom domain detection
    logger.error(LogCategory.CUSTOM_DOMAIN, 'Storage error in findExistingAppForVersion', {
      versionId,
      error: String(error)
    });
    return null;
  }
}

/**
 * Parse custom domain preview URL for identity
 * Custom domain support with LastActiveCache mapping
 */
export async function parseCustomDomainIdentity(url: string): Promise<PreviewIdentity | null> {
  try {
    const urlObj = new URL(url);
    
    
    // Skip if it's a known bubble domain (this should be handled by standard parsers)
    if (urlObj.hostname.endsWith('.bubbleapps.io') || 
        urlObj.hostname === 'bubble.io' ||
        urlObj.hostname.endsWith('.bubble.is')) {
      return null;
    }
    
    const pathname = urlObj.pathname;
    
    // Check for debug_mode=true (required for baseUrl addition, but not for recognition)
    const hasDebugMode = urlObj.searchParams.get('debug_mode') === 'true';
    
    // Extract version from path - if no version path, default to 'live'
    const versionMatch = pathname.match(/(^|\/)version-([A-Za-z0-9_-]+)(\/|$)/i);
    const versionId = versionMatch ? versionMatch[2].toLowerCase() : 'live';
    
    
    // For identity recognition, we need to determine which app this belongs to
    // Priority: 1. Hostname lookup (most reliable), 2. Version fallback (only with debug_mode=true)
    
    // Try to find app by hostname in baseUrls FIRST (works for any custom domain tab)
    let appId = await findAppByHostname(urlObj.hostname);
    
    if (!appId && hasDebugMode) {
      // For baseUrl addition, need explicit version path
      if (versionMatch) {
        appId = await findExistingAppForVersion(versionId);
      }
    }
    
    if (!appId) {
      const reason = hasDebugMode 
        ? 'No existing app/version or hostname match found'
        : 'No hostname match found and debug_mode=false prevents version fallback';
      
      logger.info(LogCategory.CUSTOM_DOMAIN, 'Cannot determine app for custom domain - will not be grouped', { 
        hostname: urlObj.hostname,
        versionId,
        hasDebugMode,
        message: reason,
        troubleshoot: hasDebugMode 
          ? 'Check if this domain exists in any app baseUrls, or if this version exists in branches'
          : 'Add debug_mode=true to enable baseUrl creation, or ensure domain is already in app baseUrls'
      });
      return null;
    }
    
    
    return {
      appId,
      versionId,
      type: 'preview',
      hostname: urlObj.hostname
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse any Bubble URL for identity
 * Returns editor or preview identity, or null if not a Bubble URL
 * Extended with automatic custom domain support
 */
export async function parseTabIdentity(url: string): Promise<TabIdentity | null> {
  // Try editor first
  const editorIdentity = parseEditorIdentity(url);
  if (editorIdentity) {
    return editorIdentity;
  }
  
  // Try standard bubble preview
  const previewIdentity = parsePreviewIdentity(url);
  if (previewIdentity) {
    return previewIdentity;
  }
  
  // Always try custom domain detection
  const customDomainIdentity = await parseCustomDomainIdentity(url);
  if (customDomainIdentity) {
    return customDomainIdentity;
  }
  
  return null;
}

/**
 * Synchronous version of parseTabIdentity for backward compatibility
 * Only supports standard Bubble domains (no custom domain support)
 */
export function parseTabIdentitySync(url: string): TabIdentity | null {
  // Try editor first
  const editorIdentity = parseEditorIdentity(url);
  if (editorIdentity) {
    return editorIdentity;
  }
  
  // Try preview
  const previewIdentity = parsePreviewIdentity(url);
  if (previewIdentity) {
    return previewIdentity;
  }
  
  return null;
}

/**
 * Check if URL is a Bubble editor page
 */
export function isEditorUrl(url: string): boolean {
  return parseEditorIdentity(url) !== null;
}

/**
 * Check if URL is a Bubble preview page
 */
export function isPreviewUrl(url: string): boolean {
  return parsePreviewIdentity(url) !== null;
}

/**
 * Check if URL is any Bubble-related page (sync version)
 */
export function isBubbleUrl(url: string): boolean {
  return parseTabIdentitySync(url) !== null;
}

/**
 * Async version to check if URL is any Bubble-related page (including custom domains)
 */
export async function isBubbleUrlAsync(url: string): Promise<boolean> {
  const identity = await parseTabIdentity(url);
  return identity !== null;
}