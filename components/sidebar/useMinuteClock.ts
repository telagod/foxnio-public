"use client";

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** One timer for every subscribed row, aligned to the wall-clock minute. */
function scheduleTick(): void {
  timer = setTimeout(() => {
    timer = null;
    for (const listener of listeners) listener();
    if (listeners.size > 0) scheduleTick();
  }, MINUTE_MS - (Date.now() % MINUTE_MS) + 25);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) scheduleTick();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * The current time, floored to the minute and shared by all callers. Only rows
 * that are mounted subscribe, so a windowed list ticks a few dozen rows once
 * per minute and an unmounted row costs nothing.
 */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, currentMinute, currentMinute);
}
