"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FoxServiceConfig } from "@/lib/fox-service-config";
import type { FoxServiceStatus } from "@/lib/fox-service";
import { foxServiceHealth } from "@/lib/fox-workbench";
import { useI18n } from "@/lib/i18n";

export function useFoxService() {
  const { t } = useI18n();
  const [status, setStatus] = useState<FoxServiceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now);
  const revision = useRef(0);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    const current = revision.current;
    try {
      const response = await fetch("/api/fox/service", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as FoxServiceStatus;
      if (revision.current === current) {
        setStatus(data);
        setFailed(false);
      }
    } catch {
      if (revision.current === current) setFailed(true);
    } finally {
      setNow(Date.now());
    }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(visible, 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      revision.current += 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const update = useCallback(async (config: Partial<FoxServiceConfig>) => {
    if (lock.current) return false;
    lock.current = true;
    revision.current += 1;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/fox/service", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error(t("fox.settings.saveFailed"));
      const next = await response.json() as FoxServiceStatus;
      revision.current += 1;
      setStatus(next);
      setFailed(false);
      setNow(Date.now());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("fox.settings.saveFailed"));
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }, [t]);
  return { status, failed, error, saving, refresh, update, health: foxServiceHealth(status, failed, now) };
}
