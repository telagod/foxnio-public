"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRecentRunsLimit } from "@/hooks/useRecentRunsLimit";
import {
  createDefaultSidebarUiState,
  createSidebarUiStatePersister,
  loadSidebarUiState,
  setRecentRunsLimit,
  type SidebarStorage,
  type SidebarUiStatePersister,
} from "@/lib/sidebar-ui-state";
import type { SidebarUiState } from "@/lib/sidebar-types";

function browserStorage(): SidebarStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type SidebarUiUpdate = (reducer: (state: SidebarUiState) => SidebarUiState) => void;

/**
 * The persisted UI state. The server render and the first client render use
 * the defaults; stored values are read right after mount. Writes are debounced
 * and flushed when the page goes away.
 */
export function useSidebarUi(): { ui: SidebarUiState; update: SidebarUiUpdate } {
  const [ui, setUi] = useState(createDefaultSidebarUiState);
  const initial = useRef(ui);
  const persister = useRef<SidebarUiStatePersister | null>(null);
  const { limit } = useRecentRunsLimit();

  useEffect(() => {
    const storage = browserStorage();
    persister.current = createSidebarUiStatePersister(storage);
    setUi(loadSidebarUiState(storage));
    const flush = () => persister.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      persister.current = null;
    };
  }, []);

  useEffect(() => {
    if (ui !== initial.current) persister.current?.schedule(ui);
  }, [ui]);

  // The limit belongs to the settings hook; the model reads it from the state.
  useEffect(() => {
    setUi((state) => setRecentRunsLimit(state, limit));
  }, [limit]);

  const update = useCallback<SidebarUiUpdate>((reducer) => setUi(reducer), []);
  return { ui, update };
}
