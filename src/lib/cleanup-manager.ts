/**
 * Centralized cleanup management for Chrome extension lifecycle
 * Prevents memory leaks from intervals, timeouts, and event listeners
 */

export class CleanupManager {
  private intervals: Set<ReturnType<typeof setInterval>> = new Set();
  private timeouts: Set<ReturnType<typeof setTimeout>> = new Set();
  private cleanupFunctions: Set<() => void> = new Set();

  /**
   * Register an interval with automatic cleanup
   */
  addInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(callback, ms);
    this.intervals.add(id);
    return id;
  }

  /**
   * Register a timeout with automatic cleanup
   */
  addTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timeouts.delete(id);
      callback();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  /**
   * Register a custom cleanup function
   */
  addCleanupFunction(cleanup: () => void): void {
    this.cleanupFunctions.add(cleanup);
  }

  /**
   * Remove specific interval
   */
  removeInterval(id: ReturnType<typeof setInterval>): void {
    if (this.intervals.has(id)) {
      clearInterval(id);
      this.intervals.delete(id);
    }
  }

  /**
   * Remove specific timeout
   */
  removeTimeout(id: ReturnType<typeof setTimeout>): void {
    if (this.timeouts.has(id)) {
      clearTimeout(id);
      this.timeouts.delete(id);
    }
  }

  /**
   * Clean up all registered resources
   */
  cleanup(): void {
    // Clear all intervals
    this.intervals.forEach(id => clearInterval(id));
    this.intervals.clear();

    // Clear all timeouts
    this.timeouts.forEach(id => clearTimeout(id));
    this.timeouts.clear();

    // Execute all cleanup functions
    this.cleanupFunctions.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        // Silently ignore cleanup errors
      }
    });
    this.cleanupFunctions.clear();
  }

  /**
   * Get statistics about registered resources
   */
  getStats(): { intervals: number; timeouts: number; cleanupFunctions: number } {
    return {
      intervals: this.intervals.size,
      timeouts: this.timeouts.size,
      cleanupFunctions: this.cleanupFunctions.size
    };
  }
}

// Singleton instance for extension-wide cleanup management
export const cleanupManager = new CleanupManager();