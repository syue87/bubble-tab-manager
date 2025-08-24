/**
 * URL parsing utilities for Bubble editor pages
 */

export interface EditorUrlParams {
  id?: string;
  tab?: string;
  name?: string;
  version?: string;
}

export interface ParsedEditorUrl {
  isEditor: boolean;
  params: EditorUrlParams;
}

/**
 * Parse a Bubble editor URL and extract relevant parameters
 */
export function parseEditorUrl(url: string): ParsedEditorUrl {
  try {
    const urlObj = new URL(url);
    
    // Check if it's an editor URL
    const isStandardEditor = urlObj.hostname === 'bubble.io' && urlObj.pathname === '/page';
    const isDedicatedEditor = urlObj.hostname.endsWith('.bubble.is') && urlObj.pathname === '/page';
    
    if (!isStandardEditor && !isDedicatedEditor) {
      return { isEditor: false, params: {} };
    }
    
    // Extract and decode parameters
    const params: EditorUrlParams = {};
    const searchParams = urlObj.searchParams;
    
    if (searchParams.has('id')) {
      params.id = decodeURIComponent(searchParams.get('id')!);
    }
    
    if (searchParams.has('tab')) {
      params.tab = decodeURIComponent(searchParams.get('tab')!);
    }
    
    if (searchParams.has('name')) {
      params.name = decodeURIComponent(searchParams.get('name')!);
    }
    
    if (searchParams.has('version')) {
      params.version = decodeURIComponent(searchParams.get('version')!);
    } else {
      // Default version is "test" if not specified
      params.version = 'test';
    }
    
    return { isEditor: true, params };
  } catch (error) {
    // Invalid URL
    return { isEditor: false, params: {} };
  }
}

/**
 * Compute the tab title based on parsed parameters
 * Always shows the app name (from 'name' parameter, fallback to 'id')
 */
export function computeTabTitle(params: EditorUrlParams): string | null {
  const { name, id } = params;
  
  // Always show app name if available from 'name' parameter
  if (name) {
    return name;
  }
  
  // Fallback: show app ID if no display name
  if (id) {
    return id;
  }
  
  // No identifiable app name
  return null;
}

/**
 * Parse URL and compute title in one step
 */
export function parseAndComputeTitle(url: string): string | null {
  const parsed = parseEditorUrl(url);
  if (!parsed.isEditor) {
    return null;
  }
  return computeTabTitle(parsed.params);
}