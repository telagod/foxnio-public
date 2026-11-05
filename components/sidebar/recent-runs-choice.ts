import { clampLimit, type RecentRunsLimitPreset } from "@/hooks/useRecentRunsLimit";

const PRESETS: readonly RecentRunsLimitPreset[] = ["10", "15", "20"];

/** The setting a chosen limit is stored as: a preset when it equals one, else the custom value. */
export function recentRunsChoice(limit: number): { preset: RecentRunsLimitPreset; custom: number | undefined } {
  const clamped = clampLimit(limit);
  const preset = PRESETS.find((candidate) => Number(candidate) === clamped);
  return preset ? { preset, custom: undefined } : { preset: "custom", custom: clamped };
}
