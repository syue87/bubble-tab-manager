import { logger, LogCategory } from './logger';

export interface AppData {
  appId: string;
  displayName?: string;
  baseUrls: string[];
  urlLastSeen?: { [url: string]: number }; // Track when each URL was last seen
  updatedAt: number;
}

export interface BranchData {
  appId: string;
  versionId: string;
  name?: string;
  displayName?: string;
  color?: chrome.tabGroups.ColorEnum;
  updatedAt: number;
}

export interface Settings {
  grouping: {
    enabled: boolean;
  };
  appOverrides: {
    [appId: string]: {
      // Future per-app settings can go here
    };
  };
}

export interface StorageSchema {
  schemaVersion: number;
  apps: { [appId: string]: AppData };
  branches: { [key: string]: BranchData };
  settings: Settings;
  extensionGroups?: number[]; // Track group IDs created by this extension
}

class Storage {
  private readonly SCHEMA_VERSION = 1;

  /**
   * Initialize storage with default schema if empty
   */
  async initialize(): Promise<void> {
    const data = await chrome.storage.local.get(null);
    
    if (!data.schemaVersion) {
      logger.info(LogCategory.STORAGE, 'Initializing storage with default schema');
      
      const defaultSchema: StorageSchema = {
        schemaVersion: this.SCHEMA_VERSION,
        apps: {},
        branches: {},
        settings: {
          grouping: { enabled: true }, // Default: grouping enabled
          appOverrides: {},
        },
        extensionGroups: [],
      };
      
      await chrome.storage.local.set(defaultSchema);
      logger.info(LogCategory.STORAGE, 'Storage initialized', { version: this.SCHEMA_VERSION });
    } else if (data.schemaVersion < this.SCHEMA_VERSION) {
      // Future: handle migrations
      logger.info(LogCategory.STORAGE, 'Storage migration needed', {
        from: data.schemaVersion,
        to: this.SCHEMA_VERSION,
      });
    } else {
      logger.debug(LogCategory.STORAGE, 'Storage already initialized', {
        version: data.schemaVersion,
      });
    }
  }

  /**
   * Get all storage data
   * @returns Complete storage schema with all extension data
   * @throws {Error} If Chrome storage access fails
   */
  async getAll(): Promise<StorageSchema> {
    const data = await chrome.storage.local.get(null);
    return data as StorageSchema;
  }

  /**
   * Get apps data with base URLs tracking
   * @returns Map of app IDs to app metadata including baseUrls arrays
   * @throws {Error} If Chrome storage access fails
   */
  async getApps(): Promise<{ [appId: string]: AppData }> {
    const { apps } = await chrome.storage.local.get('apps');
    return apps || {};
  }

  /**
   * Get single app data
   */
  async getApp(appId: string): Promise<AppData | null> {
    const apps = await this.getApps();
    return apps[appId] || null;
  }

  /**
   * Update or create app data
   */
  async setApp(appId: string, data: Partial<AppData>): Promise<void> {
    const apps = await this.getApps();
    apps[appId] = {
      ...apps[appId],
      ...data,
      appId,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ apps });
    logger.debug(LogCategory.STORAGE, 'App updated', { appId });
  }

  /**
   * Get branches data
   */
  async getBranches(): Promise<{ [key: string]: BranchData }> {
    const { branches } = await chrome.storage.local.get('branches');
    return branches || {};
  }

  /**
   * Get single branch data
   */
  async getBranch(appId: string, versionId: string): Promise<BranchData | null> {
    const branches = await this.getBranches();
    const key = `${appId}:${versionId}`;
    return branches[key] || null;
  }

  /**
   * Update or create branch data
   */
  async setBranch(appId: string, versionId: string, data: Partial<BranchData>): Promise<void> {
    const branches = await this.getBranches();
    const key = `${appId}:${versionId}`;
    branches[key] = {
      ...branches[key],
      ...data,
      appId,
      versionId,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ branches });
    logger.debug(LogCategory.STORAGE, 'Branch updated', { appId, versionId });
  }

  /**
   * Get settings
   */
  async getSettings(): Promise<Settings> {
    const { settings } = await chrome.storage.local.get('settings');
    return (
      settings || {
        grouping: { enabled: true },
        appOverrides: {},
      }
    );
  }

  /**
   * Update settings (merges with existing)
   */
  async updateSettings(updates: Partial<Settings>): Promise<void> {
    const settings = await this.getSettings();
    const merged = {
      ...settings,
      ...updates,
      grouping: {
        ...settings.grouping,
        ...(updates.grouping || {}),
      },
      appOverrides: {
        ...settings.appOverrides,
        ...(updates.appOverrides || {}),
      },
    };
    await chrome.storage.local.set({ settings: merged });
    logger.debug(LogCategory.STORAGE, 'Settings updated');
  }

  /**
   * Check if grouping is enabled
   */
  async isGroupingEnabled(): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.grouping?.enabled ?? true; // Default to true
  }

  /**
   * Get extension-created group IDs
   */
  async getExtensionGroups(): Promise<number[]> {
    const { extensionGroups } = await chrome.storage.local.get('extensionGroups');
    return extensionGroups || [];
  }

  /**
   * Add a group ID to extension-created groups
   */
  async addExtensionGroup(groupId: number): Promise<void> {
    const groups = await this.getExtensionGroups();
    if (!groups.includes(groupId)) {
      groups.push(groupId);
      await chrome.storage.local.set({ extensionGroups: groups });
      logger.debug(LogCategory.STORAGE, 'Added extension group', { groupId });
    }
  }

  /**
   * Remove a group ID from extension-created groups
   */
  async removeExtensionGroup(groupId: number): Promise<void> {
    const groups = await this.getExtensionGroups();
    const filtered = groups.filter(id => id !== groupId);
    if (filtered.length !== groups.length) {
      await chrome.storage.local.set({ extensionGroups: filtered });
      logger.debug(LogCategory.STORAGE, 'Removed extension group', { groupId });
    }
  }

  /**
   * Check if a group was created by this extension
   */
  async isExtensionGroup(groupId: number): Promise<boolean> {
    const groups = await this.getExtensionGroups();
    return groups.includes(groupId);
  }

  /**
   * Add base URL to app's baseUrls list with LRU-like behavior
   * Respects cap of 12 items and never evicts canonical bubbleapps.io domain
   */
  async addBaseUrl(appId: string, hostname: string): Promise<void> {
    const app = await this.getApp(appId);
    const canonical = `${appId}.bubbleapps.io`;
    
    // Initialize baseUrls if not exists
    const baseUrls = app?.baseUrls || [canonical];
    
    // Ensure canonical is always present
    if (!baseUrls.includes(canonical)) {
      baseUrls.unshift(canonical);
    }
    
    // Don't add if already exists
    if (baseUrls.includes(hostname)) {
      // Move to end (most recent)
      const filtered = baseUrls.filter(url => url !== hostname);
      filtered.push(hostname);
      await this.setApp(appId, { baseUrls: filtered });
      return;
    }
    
    // Add new hostname
    baseUrls.push(hostname);
    
    // Enforce cap of 12, protecting canonical
    if (baseUrls.length > 12) {
      // Remove oldest non-canonical entries
      const nonCanonical = baseUrls.filter(url => url !== canonical);
      const canonical_entries = baseUrls.filter(url => url === canonical);
      const trimmed = [...canonical_entries, ...nonCanonical.slice(-11)];
      await this.setApp(appId, { baseUrls: trimmed });
    } else {
      await this.setApp(appId, { baseUrls });
    }
    
    logger.debug(LogCategory.CUSTOM_DOMAIN, 'Added base URL', { appId, hostname });
  }

}

export const storage = new Storage();