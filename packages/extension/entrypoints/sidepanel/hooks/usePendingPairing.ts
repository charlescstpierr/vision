import { useCallback, useEffect, useState } from 'react';
import { PENDING_PAIRING_STORAGE_KEY, type PendingPairing } from '@vizion/shared';
import { readStoredPending } from '../../../utils/pairing.js';

/**
 * Surfaces a pairing the content script picked up from the server's `/pair`
 * page and is waiting on the user to confirm. Kept separate from
 * `useSettings`: a pending pairing is an *offer*, and only `confirm` turns it
 * into the live connection setting.
 */
export function usePendingPairing(): {
  pending: PendingPairing | null;
  /** Clears the offer. Call after applying it, or when the user declines. */
  dismiss: () => void;
} {
  const [pending, setPending] = useState<PendingPairing | null>(null);

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(PENDING_PAIRING_STORAGE_KEY).then((result) => {
      if (!cancelled) setPending(readStoredPending(result[PENDING_PAIRING_STORAGE_KEY]));
    });

    // The pairing page is a *different tab*, so the offer usually lands while
    // the panel is already open: without this listener it would only appear
    // after a reopen.
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(PENDING_PAIRING_STORAGE_KEY in changes)) return;
      setPending(readStoredPending(changes[PENDING_PAIRING_STORAGE_KEY]?.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const dismiss = useCallback(() => {
    setPending(null);
    void chrome.storage.local.remove(PENDING_PAIRING_STORAGE_KEY);
  }, []);

  return { pending, dismiss };
}
