import { useEffect, useState } from 'react';

async function queryActiveTabUrl(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url;
}

/**
 * Tracks the URL of the active tab in the current window, so overlay-mode
 * UI (OverridePanel) can key overrides to the page actually being viewed.
 * Updates on tab activation and on navigation/reload of the active tab.
 */
export function useActiveTab(): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void queryActiveTabUrl().then((initial) => {
      if (!cancelled) setUrl(initial);
    });

    const refresh = () => {
      void queryActiveTabUrl().then((next) => {
        if (!cancelled) setUrl(next);
      });
    };

    const onActivated = () => refresh();
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!tab.active) return;
      if (changeInfo.status === 'complete' || changeInfo.url) refresh();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return url;
}
