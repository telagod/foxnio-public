"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Briefing } from "@/lib/briefing";
import { REFRESH_BRIEFING_EVENT } from "@/lib/briefing-events";
import { subscribeDataTopics } from "@/lib/data-store";
import { useI18n } from "@/lib/i18n";
import { openResilientEventStream } from "@/lib/event-stream";

export interface BriefingState {
  briefing: Briefing | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Durable changes and live RPC use separate clocks; neither can cache the other. */
export function useBriefing(options: { enabled?: boolean; days?: number; excludeSessionId?: string | null } = {}): BriefingState {
  const { enabled = true, days = 7, excludeSessionId = null } = options;
  const { t } = useI18n();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const reading = useRef<Promise<void> | null>(null);
  const queued = useRef(false);

  const load = useCallback((): Promise<void> => {
    if (reading.current) { queued.current = true; return reading.current; }
    const sequence = ++requestSequence.current;
    const request = Promise.resolve().then(async () => {
      if (sequence !== requestSequence.current) return;
      do {
        queued.current = false;
        setRefreshing(true);
        try {
          const query = new URLSearchParams({ days: String(days) });
          if (excludeSessionId) query.set("excludeSession", excludeSessionId);
          const response = await fetch(`/api/briefing?${query}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const next = await response.json() as Briefing;
          if (sequence !== requestSequence.current) return;
          setBriefing(next);
          setError(null);
        } catch {
          if (sequence === requestSequence.current) setError(t("briefing.loadFailed"));
        } finally {
          if (sequence === requestSequence.current) { setRefreshing(false); setLoading(false); }
        }
        if (sequence !== requestSequence.current) return;
      } while (queued.current);
    }).finally(() => { if (reading.current === request) reading.current = null; });
    reading.current = request;
    return request;
  }, [days, excludeSessionId, t]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    let wake: NodeJS.Timeout | undefined;
    const onRefresh = () => {
      if (wake !== undefined || document.visibilityState !== "visible") return;
      wake = setTimeout(() => { wake = undefined; void load(); }, 100);
    };
    const durable = subscribeDataTopics(["sessions", "projects", "notification-history", "fox-pointer", "fox-observation", "fox-display", "operator-settings"], onRefresh);
    const live = openResilientEventStream({ kind: "running" }, onRefresh, { onOpen: onRefresh });
    const onVisible = () => { if (document.visibilityState === "visible") onRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
    return () => {
      requestSequence.current++;
      reading.current = null;
      queued.current = false;
      durable(); live(); clearTimeout(wake);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
    };
  }, [enabled, load]);

  return { briefing, loading, refreshing, error, refresh: load };
}
