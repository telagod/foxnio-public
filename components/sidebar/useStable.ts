"use client";

import { useRef } from "react";

/** `value`, or the previous value while the two are equal: derived collections keep their identity until their content changes. */
export function useStable<T>(value: T, isEqual: (previous: T, next: T) => boolean): T {
  const kept = useRef(value);
  if (kept.current !== value && !isEqual(kept.current, value)) kept.current = value;
  return kept.current;
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
