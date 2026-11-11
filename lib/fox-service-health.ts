/**
 * Health label for the FOX status indicator.
 *
 * The workbench join that used to live here belonged to the retired Chief
 * control plane. Workers now come from native lineage inside the briefing, so
 * only the service-state mapping remains.
 */
export function foxServiceHealth(
  status: { config: { enabled: boolean }; lastTickAt: string | null; lastRunError: string | null } | null,
  failed: boolean,
  now: number,
): "loading" | "unavailable" | "manual" | "starting" | "checking" | "stale" | "error" {
  if (failed) return "unavailable";
  if (!status) return "loading";
  if (status.lastRunError) return "error";
  if (!status.config.enabled) return "manual";
  if (!status.lastTickAt) return "starting";
  const at = Date.parse(status.lastTickAt);
  return Number.isFinite(at) && now - at < 150_000 && at <= now + 60_000 ? "checking" : "stale";
}
