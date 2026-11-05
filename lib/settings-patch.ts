/**
 * Patch helpers for PUT /api/omp-settings. The endpoint writes only the keys it
 * receives, so clients send the keys they changed instead of a whole snapshot
 * (a snapshot would revert whatever another tab, panel or the omp CLI changed
 * since it was loaded).
 */

export type SettingsPatch<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? SettingsPatch<T[K]> : T[K];
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `retry.fallbackChains` is replaced as a whole by the server, so a patch
 * carries it whole and merging must not splice individual roles into it. */
const WHOLE_VALUE_KEY = "fallbackChains";

/** `base` with `patch` applied: nested objects merge key by key, everything
 * else (scalars, arrays, fallbackChains) is replaced. Inputs are not mutated. */
export function mergeSettingsPatch<T extends object>(base: T, patch: SettingsPatch<T>): T {
  const result: PlainObject = { ...(base as PlainObject) };
  for (const [key, value] of Object.entries(patch as PlainObject)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) && key !== WHOLE_VALUE_KEY
      ? mergeSettingsPatch(current, value)
      : value;
  }
  return result as T;
}

/** The patch that turns `base` into `next`: top-level keys that differ, and for
 * section objects only the keys inside them that differ (siblings stay out of
 * the request). Values are compared structurally. */
export function diffSettingsSections<T extends object>(base: T, next: T): SettingsPatch<T> {
  const patch: PlainObject = {};
  for (const [key, value] of Object.entries(next as PlainObject)) {
    const before = (base as PlainObject)[key];
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    if (isPlainObject(value) && isPlainObject(before) && key !== WHOLE_VALUE_KEY) {
      const section: PlainObject = {};
      for (const [name, entry] of Object.entries(value)) {
        if (JSON.stringify(before[name]) !== JSON.stringify(entry)) section[name] = entry;
      }
      patch[key] = section;
    } else {
      patch[key] = value;
    }
  }
  return patch as SettingsPatch<T>;
}
