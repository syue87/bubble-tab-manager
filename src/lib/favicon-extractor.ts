/**
 * Favicon extraction system for Bubble editor tabs
 * Extracts SVG icons from the selected sidebar tab and converts to favicon
 */

import { logger, LogCategory } from './logger';
import { FAVICON } from './constants';

// Cache the current favicon to prevent unnecessary updates
let currentFaviconSvg: string | null = null;

/**
 * Extract the selected tab's SVG icon from the sidebar
 */
function extractSelectedTabSvg(): { svg: string; tabName: string } | null {
  try {
    // Look for the selected tab in the sidebar
    const selectedButton = document.querySelector('.main-tab-bar button.selected');
    
    if (!selectedButton) {
      logger.debug(LogCategory.FAVICON, 'No selected tab found in sidebar');
      return null;
    }
    
    // Get the tab name
    const tabName = selectedButton.getAttribute('data-tab-item') || 
                   selectedButton.getAttribute('aria-label') || 
                   'Unknown';
    
    // Find the SVG within the selected button
    const svgElement = selectedButton.querySelector('svg');
    
    if (!svgElement) {
      logger.debug(LogCategory.FAVICON, 'No SVG found in selected tab', { tabName });
      return null;
    }
    
    // Clone the SVG and get its outer HTML
    const clonedSvg = svgElement.cloneNode(true) as SVGElement;
    
    // Ensure the SVG has proper attributes for favicon use
    clonedSvg.setAttribute('width', FAVICON.SIZE.toString());
    clonedSvg.setAttribute('height', FAVICON.SIZE.toString());
    clonedSvg.setAttribute('viewBox', `0 0 ${FAVICON.SIZE} ${FAVICON.SIZE}`);
    
    // Make sure the icon is visible by setting fill if needed
    const paths = clonedSvg.querySelectorAll('path');
    paths.forEach(path => {
      if (!path.getAttribute('fill') || path.getAttribute('fill') === 'currentColor') {
        path.setAttribute('fill', FAVICON.DEFAULT_FILL_COLOR); // Dark color for visibility
      }
    });
    
    const svgString = clonedSvg.outerHTML;
    
    logger.debug(LogCategory.FAVICON, 'Extracted SVG from selected tab', { 
      tabName, 
      svgLength: svgString.length 
    });
    
    return { svg: svgString, tabName };
  } catch (error) {
    logger.debug(LogCategory.FAVICON, 'Failed to extract selected tab SVG', { 
      error: String(error) 
    });
    return null;
  }
}

/**
 * Convert SVG string to data URL favicon
 */
function svgToFaviconDataUrl(svgString: string): string {
  // Create a proper SVG data URL
  const encodedSvg = encodeURIComponent(svgString);
  return `data:image/svg+xml,${encodedSvg}`;
}

/**
 * Update the page favicon with the selected tab's icon
 */
export function updateFaviconFromSelectedTab(): void {
  try {
    const result = extractSelectedTabSvg();
    
    if (!result) {
      logger.debug(LogCategory.FAVICON, 'No tab SVG extracted, favicon not updated');
      return;
    }
    
    const { svg, tabName } = result;
    
    // Skip update if the SVG hasn't changed
    if (currentFaviconSvg === svg) {
      logger.debug(LogCategory.FAVICON, 'Favicon SVG unchanged, skipping update', { tabName });
      return;
    }
    
    const faviconUrl = svgToFaviconDataUrl(svg);
    
    // Find or create favicon link element
    let faviconLink = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    
    if (!faviconLink) {
      faviconLink = document.createElement('link');
      faviconLink.rel = 'icon';
      faviconLink.type = 'image/svg+xml';
      document.head.appendChild(faviconLink);
    }
    
    // Update the favicon
    faviconLink.href = faviconUrl;
    currentFaviconSvg = svg;
    
    logger.info(LogCategory.FAVICON, 'Favicon updated from selected tab', { 
      tabName,
      faviconUrlLength: faviconUrl.length
    });
    
  } catch (error) {
    logger.debug(LogCategory.FAVICON, 'Failed to update favicon from selected tab', { 
      error: String(error) 
    });
  }
}

/**
 * Get current favicon status for debugging
 */
export function getFaviconStatus(): { currentSvg: string | null; hasSelectedTab: boolean } {
  const selectedButton = document.querySelector('.main-tab-bar button.selected');
  return {
    currentSvg: currentFaviconSvg,
    hasSelectedTab: !!selectedButton
  };
}

/**
 * Force update favicon by clearing cache and re-extracting
 */
export function forceUpdateFavicon(): void {
  currentFaviconSvg = null;
  updateFaviconFromSelectedTab();
}