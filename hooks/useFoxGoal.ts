"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FoxGoalSnapshot } from "@/lib/fox-goal-types";
import { REFRESH_BRIEFING_EVENT } from "@/lib/briefing-events";
import { useI18n } from "@/lib/i18n";
import { subscribeDataTopics } from "@/lib/data-store";
import { openResilientEventStream } from "@/lib/event-stream";

type GoalAction = "pause" | "resume" | "stop";

export interface FoxGoalState {
  snapshot: FoxGoalSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  controlError: string | null;
  pending: GoalAction | null;
  refresh: () => Promise<void>;
  control: (action: GoalAction) => Promise<boolean>;
}

function isSnapshot(value: unknown): value is FoxGoalSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<FoxGoalSnapshot>;
  return typeof data.supported === "boolean"
    && (data.goal === null || Boolean(data.goal && typeof data.goal === "object" && "goal" in data.goal))
    && (data.grant === null || Boolean(data.grant && typeof data.grant === "object" && "terms" in data.grant))
    && Array.isArray(data.assignments) && Array.isArray(data.reviews) && Array.isArray(data.reports)
    && Array.isArray(data.todoPhases) && typeof data.dispatchesUsed === "number"
    && ["running", "next", "waiting", "paused", "uncertain"].includes(data.recovery ?? "")
    && (data.updatedAt === null || typeof data.updatedAt === "string");
}

export function useFoxGoal(conversationId: string | null = null): FoxGoalState {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<FoxGoalSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [pending, setPending] = useState<GoalAction | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const reading = useRef<Promise<void> | null>(null);
  const controlling = useRef<number | null>(null);
  const queuedHint = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    if (controlling.current !== null) return Promise.resolve();
    if (reading.current) return reading.current;
    const current = revision.current;
    setRefreshing(true);
    const request = Promise.resolve().then(async () => {
      try {
        const response = await fetch("/api/fox/goal", { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next: unknown = await response.json();
        if (!isSnapshot(next)) throw new Error("Invalid FOX goal snapshot");
        if (alive.current && current === revision.current) { setSnapshot(next); setError(null); }
      } catch {
        if (alive.current && current === revision.current) setError(t("fox.goal.loadFailed"));
      } finally {
        if (reading.current === request) reading.current = null;
        if (alive.current && current === revision.current) { setLoading(false); setRefreshing(false); }
        if (alive.current && current === revision.current && queuedHint.current) {
          queuedHint.current = false;
          void refresh();
        }
      }
    });
    reading.current = request;
    return request;
  }, [t]);

  const control = useCallback(async (action: GoalAction): Promise<boolean> => {
    if (controlling.current !== null) return false;
    const current = ++revision.current;
    controlling.current = current;
    reading.current = null;
    setRefreshing(false);
    setPending(action);
    setControlError(null);
    let ok = false;
    try {
      const response = await fetch("/api/fox/goal", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const next: unknown = await response.json();
      if (!response.ok) {
        const detail = next && typeof next === "object" && "error" in next ? next.error : null;
        throw new Error(typeof detail === "string" ? detail : t("fox.goal.controlFailed"));
      }
      if (!isSnapshot(next)) throw new Error(t("fox.goal.controlFailed"));
      if (alive.current && current === revision.current) { setSnapshot(next); setError(null); setLoading(false); ok = true; }
    } catch (cause) {
      if (alive.current && current === revision.current) setControlError(cause instanceof Error ? cause.message : t("fox.goal.controlFailed"));
    } finally {
      if (controlling.current === current) controlling.current = null;
      if (alive.current && current === revision.current) {
        setPending(null);
        if (queuedHint.current) { queuedHint.current = false; void refresh(); }
        // A failed Stop can still have revoked admission. Re-read, never undo it locally.
        if (!ok) void refresh();
      }
    }
    return ok;
  }, [refresh, t]);

  useEffect(() => {
    alive.current = true;
    revision.current += 1;
    reading.current = null;
    controlling.current = null;
    queuedHint.current = false;
    setPending(null);
    setSnapshot(null);
    setError(null);
    setControlError(null);
    setLoading(true);
    void refresh();
    let wake: number | undefined;
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const onRefresh = () => {
      if (wake) return;
      wake = window.setTimeout(() => {
        wake = undefined;
        if (reading.current || controlling.current !== null) queuedHint.current = true;
        else void refresh();
      }, 100);
    };
    const durable = subscribeDataTopics(["sessions", "fox-pointer", "fox-observation", "fox-display", "operator-settings"], onRefresh);
    const live = openResilientEventStream({ kind: "running" }, onRefresh, { onOpen: onRefresh });
    window.addEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      revision.current += 1;
      reading.current = null;
      clearTimeout(wake);
      durable();
      live();
      queuedHint.current = false;
      window.removeEventListener(REFRESH_BRIEFING_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [conversationId, refresh]);

  return { snapshot, loading, refreshing, error, controlError, pending, refresh, control };
}
