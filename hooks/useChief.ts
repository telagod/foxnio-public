"use client";

import { useSyncExternalStore } from "react";
import type { ChiefState } from "@/lib/chief-store";
import { REFRESH_BRIEFING_EVENT, refreshBriefing } from "@/lib/briefing-events";

interface Snapshot {
  state: ChiefState | null;
  loading: boolean;
  failed: boolean;
}

const initial: Snapshot = { state: null, loading: true, failed: false };
let snapshot = initial;
let revision = 0;
let pending: Promise<void> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function refreshChief(): Promise<void> {
  if (pending) return pending;
  const current = revision;
  pending = (async () => {
    try {
      const response = await fetch("/api/chief/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json() as ChiefState;
      if (current === revision) publish({ state, loading: false, failed: false });
    } catch {
      if (current === revision) publish({ ...snapshot, loading: false, failed: true });
    } finally {
      pending = null;
    }
  })();
  return pending;
}

async function mutateChief(path: string, method: string, body?: unknown): Promise<void> {
  revision += 1;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    revision += 1;
    await pending;
    await refreshChief();
    throw error;
  }
  const data = await response.json().catch(() => null) as (ChiefState & { state?: ChiefState; error?: string }) | null;
  revision += 1;
  const state = data?.state ?? (Array.isArray(data?.tickets) ? data : null);
  if (state) publish({ state, loading: false, failed: false });
  if (!state) {
    await pending;
    await refreshChief();
  }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  refreshBriefing();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshChief();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refreshChief();
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener(REFRESH_BRIEFING_EVENT, refreshVisible);
    stop = () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener(REFRESH_BRIEFING_EVENT, refreshVisible);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stop?.();
      stop = null;
    }
  };
}

export function useChief() {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => initial);
  return { ...value, refresh: refreshChief, mutate: mutateChief };
}
