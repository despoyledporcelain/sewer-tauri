import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';

const CHECK_INTERVAL = 60 * 60 * 1000;

export function useAppUpdate(beforeInstall) {
  const enabled = isTauri() && import.meta.env.PROD;
  const [currentVersion, setCurrentVersion] = useState(null);
  const [availableVersion, setAvailableVersion] = useState(null);
  const [status, setStatus] = useState('idle');
  const update = useRef(null);
  const busy = useRef(false);
  const lifetime = useRef(null);

  const checkNow = useCallback(async (manual = false) => {
    const owner = lifetime.current;
    if (!enabled || !owner || busy.current) return;
    busy.current = true;
    if (manual) setStatus('checking');
    try {
      const next = await check({ timeout: 15000 });
      if (lifetime.current !== owner) {
        await next?.close();
        return;
      }
      const previous = update.current;
      update.current = next ? { package: next, downloaded: false } : null;
      setAvailableVersion(next?.version ?? null);
      setStatus(next ? 'available' : manual ? 'current' : 'idle');
      void previous?.package.close().catch(() => {});
    } catch (error) {
      console.warn('Update check failed', error);
      if (manual && lifetime.current === owner) setStatus('checkFailed');
    } finally {
      busy.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    const owner = {};
    lifetime.current = owner;
    if (isTauri()) {
      getVersion().then(version => {
        if (lifetime.current === owner) setCurrentVersion(version);
      }).catch(() => {});
    }
    const initial = enabled ? setTimeout(checkNow, 3000) : undefined;
    const interval = enabled ? setInterval(checkNow, CHECK_INTERVAL) : undefined;
    return () => {
      lifetime.current = null;
      clearTimeout(initial);
      clearInterval(interval);
      const previous = update.current;
      update.current = null;
      void previous?.package.close().catch(() => {});
    };
  }, [checkNow, enabled]);

  const install = async () => {
    const next = update.current;
    if (!next || busy.current) return;
    busy.current = true;
    try {
      if (!next.downloaded) {
        setStatus('downloading');
        await next.package.download(undefined, { timeout: 180000 });
        next.downloaded = true;
      }
      setStatus('installing');
      await beforeInstall();
      await next.package.install({ restartAfterInstall: true });
    } catch (error) {
      console.warn('Update installation failed', error);
      setStatus('installFailed');
    } finally {
      busy.current = false;
    }
  };

  return { enabled, currentVersion, availableVersion, status, checkNow, install };
}
