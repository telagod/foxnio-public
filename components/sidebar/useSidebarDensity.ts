"use client";

import { useSyncExternalStore } from "react";
import { useTouchTargets, type TouchTargetsPreference } from "@/hooks/useTouchTargets";
import type { SidebarDensity } from "@/lib/sidebar-types";

/** Touch-first devices: no hover, or a coarse primary pointer. */
export const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";

/**
 * Density from the input device and the user's touch-target setting. The
 * accessible setting and coarse pointers both give `touch` (hover-only
 * affordances do not exist there, so `compact` never applies to them); the
 * compact setting gives `compact`; otherwise `comfortable`.
 */
export function resolveSidebarDensity(coarsePointer: boolean, preference: TouchTargetsPreference): SidebarDensity {
  if (preference === "accessible" || coarsePointer) return "touch";
  return preference === "compact" ? "compact" : "comfortable";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia) && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** The density the sidebar renders in; the server and the first client render assume a desktop pointer. */
export function useSidebarDensity(): SidebarDensity {
  const coarsePointer = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const { touchTargets } = useTouchTargets();
  return resolveSidebarDensity(coarsePointer, touchTargets);
}
