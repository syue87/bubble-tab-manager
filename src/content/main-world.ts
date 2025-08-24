(function() {
  'use strict';
  
  if ((window as any).__btmMainWorldInstalled) {
    return;
  }
  (window as any).__btmMainWorldInstalled = true;

  if ((window as any).__btmHistoryWrapped) {
    return;
  }
  (window as any).__btmHistoryWrapped = true;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function notifyUrlChange(method: string) {
    window.dispatchEvent(new CustomEvent('btm:urlchange', { 
      detail: { method, url: location.href, timestamp: Date.now() }
    }));
  }

  history.pushState = function(state: any, title: string, url?: string | URL | null) {
    originalPushState.call(history, state, title, url);
    notifyUrlChange('pushState');
  };

  history.replaceState = function(state: any, title: string, url?: string | URL | null) {
    originalReplaceState.call(history, state, title, url);
    notifyUrlChange('replaceState');
  };

  window.addEventListener('popstate', () => {
    notifyUrlChange('popstate');
  });
})();