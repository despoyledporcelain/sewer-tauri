import { useEffect, useState } from 'react';
import { loadHistoryCovers } from './history-covers.js';

export function useHistoryCovers({ visible, entries, auth }) {
  const [covers, setCovers] = useState({});
  const token = auth?.token;
  const clientId = auth?.clientId;
  useEffect(() => {
    if (!visible || !entries.length) return;
    let disposed = false;
    loadHistoryCovers(entries, {
      api: window.electronAPI, auth: { token, clientId }, cancelled: () => disposed,
      onCover: (key, url) => {
        if (!disposed) setCovers(previous => previous[key] === url ? previous : { ...previous, [key]: url });
      },
    });
    return () => { disposed = true; };
  }, [visible, entries, token, clientId]);
  return covers;
}
