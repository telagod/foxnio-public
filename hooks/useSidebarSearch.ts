"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createSidebarSearch } from "@/lib/sidebar-search";
import type { SidebarSearchState } from "@/lib/sidebar-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";

export interface UseSidebarSearch {
  /** Ranked hits for the current query, `null` while there is nothing to search for. */
  search: SidebarSearchState | null;
  /** The text as typed, for the input value. */
  query: string;
  setQuery: (value: string) => void;
  /** Abort the transcript search, keeping the hits found so far. */
  stop: () => void;
}

const getServerSnapshot = (): null => null;

export function useSidebarSearch(sessions: readonly SessionInfo[], projects: readonly ManagedProject[]): UseSidebarSearch {
  const [controller] = useState(createSidebarSearch);
  const [query, setRawQuery] = useState("");
  const search = useSyncExternalStore(controller.subscribe, controller.getSnapshot, getServerSnapshot);

  useEffect(() => {
    controller.setSessions(sessions, projects);
  }, [controller, sessions, projects]);

  useEffect(() => () => controller.dispose(), [controller]);

  const setQuery = useCallback(
    (value: string) => {
      setRawQuery(value);
      controller.setQuery(value);
    },
    [controller],
  );

  return { search, query, setQuery, stop: controller.stop };
}
