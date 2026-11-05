"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeSettingsPatch, type SettingsPatch } from "@/lib/settings-patch";

interface Options<T> {
  /** Runs after each accepted save with the server's settings. */
  onSaved?: (settings: T) => void | Promise<void>;
}

/**
 * Optimistic editing of omp's native settings (`/api/omp-settings`).
 *
 * Each edit is a patch holding only the keys the user changed, so a save never
 * rewrites keys that another tab or panel changed meanwhile. Patches are sent
 * one request at a time, coalescing whatever accumulates while a request is
 * in flight. A rejected patch is dropped and the display rolls back to the last
 * server-confirmed settings plus the patches still waiting to be sent, so the
 * outcome does not depend on the order responses arrive in.
 */
export function useNativeSettingsPatches<T extends object>(options: Options<T> = {}) {
  const [settings, setSettings] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirmedRef = useRef<T | null>(null);
  const pendingRef = useRef<SettingsPatch<T> | null>(null);
  const drainingRef = useRef(false);
  const editedRef = useRef(false);
  const onSavedRef = useRef(options.onSaved);
  useEffect(() => {
    onSavedRef.current = options.onSaved;
  });

  /** Call before (re)loading: the next `setLoaded` may replace the display. */
  const beginLoad = useCallback(() => {
    editedRef.current = false;
  }, []);

  /** Settings as the server holds them. An edit made while the load was in
   * flight keeps the display, the load only updates the rollback baseline. */
  const setLoaded = useCallback((loaded: T) => {
    confirmedRef.current = loaded;
    if (!editedRef.current) setSettings(loaded);
  }, []);

  const patch = useCallback((change: SettingsPatch<T>) => {
    editedRef.current = true;
    setError(null);
    setSettings((current) => mergeSettingsPatch(current ?? ({} as T), change));
    pendingRef.current = mergeSettingsPatch((pendingRef.current ?? {}) as T, change) as SettingsPatch<T>;
    if (drainingRef.current) return;
    drainingRef.current = true;
    setSaving(true);

    void (async () => {
      try {
        while (pendingRef.current !== null) {
          const body = pendingRef.current;
          pendingRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ settings: body }),
            });
            const data = (await response.json()) as { settings?: T; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            confirmedRef.current = data.settings ?? mergeSettingsPatch(confirmedRef.current ?? ({} as T), body);
            if (pendingRef.current === null) setSettings(confirmedRef.current);
            await onSavedRef.current?.(confirmedRef.current);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setSettings(mergeSettingsPatch(confirmedRef.current ?? ({} as T), (pendingRef.current ?? {}) as SettingsPatch<T>));
          }
        }
      } finally {
        drainingRef.current = false;
        setSaving(false);
      }
    })();
  }, []);

  return { settings, error, setError, saving, beginLoad, setLoaded, patch };
}
