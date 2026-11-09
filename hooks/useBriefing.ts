"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Briefing } from "@/lib/briefing";
import { REFRESH_BRIEFING_EVENT } from "@/lib/briefing-events";
import { useI18n } from "@/lib/i18n";
import { openResilientEventStream } from "@/lib/event-stream";

export interface BriefingState {
  briefing: Briefing | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// The card and the status panel are separate consumers with their own hook
// state; one module-level chain keeps BRIEFING.md in step without posting the
// same snapshot twice. A failed POST leaves the marker untouched so the next
// poll retries.
let mirroredGeneratedAt: string | null = null;
let mirrorQueue: Promise<void> = Promise.resolve();

function mirrorBriefing(briefing: Briefing): void {
  if (briefing.generatedAt === mirroredGeneratedAt) return;
  const target = briefing.generatedAt;
  mirrorQueue = mirrorQueue
    .then(async () => {
      if (target === mirroredGeneratedAt) return;
      const response = await fetch("/api/fox/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefing }),
      });
      if (response.ok) mirroredGeneratedAt = target;
    })
    .catch(() => {});
}

/**
 * Shared read-only briefing fetch for the FOX card and status panel. The card
 * is always mounted, so polling stops when the tab is hidden and resumes on
 * focus; the server caches the session list for 30s, so this is a light request.
 * Every unfiltered snapshot is also mirrored into FOX's BRIEFING.md, which the
 * resident chat reads for status answers.
 */
export function useBriefing(options: { enabled?: boolean; days?: number; excludeSessionId?: string | null } = {}): BriefingState {
  const { enabled = true, days = 7, excludeSessionId = null } = options;
  const { t } = useI18n();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setRefreshing(true);
    try {
      const query = new URLSearchParams({ days: String(days) });
      if (excludeSessionId) query.set("excludeSession", excludeSessionId);
      const response = await fetch(`/api/briefing?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as Briefing;
      if (sequence !== requestSequence.current) return;
      setBriefing(next);
      if (!excludeSessionId) mirrorBriefing(next);
      setError(null);
    } catch {
      if (sequence === requestSequence.current) setError(t("briefing.loadFailed"));
    } finally {
      if (sequence === requestSequence.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [days, excludeSessionId, t]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    let reportsTimer: ReturnType<typeof setTimeout> | undefined;
    const reports = openResilientEventStream({ kind: "fox-reports" }, () => {
      if (document.visibilityState !== "visible" || reportsTimer) return;
      reportsTimer = setTimeout(() => { reportsTimer = undefined; void load(); }, 100);
    });
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onRefresh = () => { void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
    return () => {
      requestSequence.current += 1;
      reports();
      clearTimeout(reportsTimer);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
    };
  }, [enabled, load]);

  return { briefing, loading, refreshing, error, refresh: load };
}
