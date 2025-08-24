/**
 * Development logger with configurable verbosity
 */

interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: unknown;
}

class Logger {
  private enabled = process.env.NODE_ENV === 'development'; // Environment-dependent
  private isDev = process.env.NODE_ENV === 'development'; // Environment-dependent  
  private buffer: LogEntry[] = [];
  private maxBufferSize = 100;

  constructor() {
    this.init();
  }

  private async init() {
    // Check if logging is enabled in storage
    const { devLogging } = await chrome.storage.local.get('devLogging');
    this.enabled = devLogging === true || this.isDev;
  }

  private log(level: LogEntry['level'], category: string, message: string, data?: unknown) {
    if (!this.enabled) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      category,
      message,
      data,
    };

    // Console output in dev
    if (this.isDev) {
      const prefix = `[BTM:${category}]`;
      const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      logFn(prefix, message, data !== undefined ? data : '');
    }

    // Maintain ring buffer
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  debug(category: string, message: string, data?: unknown) {
    this.log('debug', category, message, data);
  }

  info(category: string, message: string, data?: unknown) {
    this.log('info', category, message, data);
  }

  warn(category: string, message: string, data?: unknown) {
    this.log('warn', category, message, data);
  }

  error(category: string, message: string, data?: unknown) {
    this.log('error', category, message, data);
  }

  async setEnabled(enabled: boolean) {
    this.enabled = enabled;
    await chrome.storage.local.set({ devLogging: enabled });
  }

  getBuffer(): ReadonlyArray<LogEntry> {
    return [...this.buffer];
  }
}

export const logger = new Logger();

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Log categories for consistent naming
export const LogCategory = {
  INIT: 'init',
  STORAGE: 'storage',
  TAB: 'tab',
  GROUP: 'group',
  CONTENT: 'content',
  MESSAGE: 'message',
  SCRAPE: 'scrape',
  CUSTOM_DOMAIN: 'customDomain',
  FAVICON: 'favicon',
} as const;