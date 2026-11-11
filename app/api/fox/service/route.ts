import { NextResponse, type NextRequest } from "next/server";
import { isAbsolute } from "path";
import {
  foxServiceStatus,
  requestFoxServiceTick,
  startFoxService,
} from "@/lib/fox-service";
import {
  readFoxServiceConfig,
  foxDispatchProjectKey,
  writeFoxServiceConfig,
  type FoxServiceConfig,
} from "@/lib/fox-service-config";
import { isRecord } from "@/lib/type-guards";
import { getFoxGoalSnapshot, invalidateFoxGoalPolicy } from "@/lib/fox-goal-service";
import { apiErrorResponse } from "@/lib/api-utils";
import { storageRequest } from "@/lib/storage/client";

export const dynamic = "force-dynamic";

export async function GET() {
  // Idempotent: instrumentation starts this on boot, but a dev server or a
  // deployment with instrumentation disabled still gets a working toggle.
  try {
    await startFoxService();
    return NextResponse.json(await foxServiceStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * PATCH /api/fox/service
 *
 * Only the observation and native dispatch policies the service understands;
 * do not accept arbitrary configuration or approval records.
 */
export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Request body must be an object", code: "invalid_request" }, { status: 400 });
  }

  try {
    await storageRequest({ operation: "head" });
    const current = readFoxServiceConfig();
    const next: FoxServiceConfig = {
      ...current,
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      quietStart: typeof body.quietStart === "string" ? body.quietStart : current.quietStart,
      quietEnd: typeof body.quietEnd === "string" ? body.quietEnd : current.quietEnd,
      maxDailyMessages: typeof body.maxDailyMessages === "number" ? body.maxDailyMessages : current.maxDailyMessages,
      maxDailyGoalNotifications: typeof body.maxDailyGoalNotifications === "number" ? body.maxDailyGoalNotifications : current.maxDailyGoalNotifications,
    };
    if (body.dispatchPolicies !== undefined) {
      if (!isRecord(body.dispatchPolicies) || Object.entries(body.dispatchPolicies).some(([path, policy]) => !isAbsolute(path) || !["observe", "confirm", "auto"].includes(String(policy)))) {
        return NextResponse.json({ error: "Invalid project dispatch policy", code: "invalid_policy" }, { status: 400 });
      }
      next.dispatchPolicies = { ...current.dispatchPolicies };
      for (const [path, policy] of Object.entries(body.dispatchPolicies)) {
        next.dispatchPolicies[foxDispatchProjectKey(path)] = policy as "observe" | "confirm" | "auto";
      }
    }
    const changedProjects = Object.entries(next.dispatchPolicies ?? {}).filter(([path, policy]) =>
      policy !== (current.dispatchPolicies?.[path] ?? "confirm")).map(([path]) => path);
    if (changedProjects.length) {
      const snapshot = await getFoxGoalSnapshot();
      if (!snapshot.supported) return NextResponse.json({ error: snapshot.reason || "FOX authorization could not be checked", code: "fox_policy_unavailable" }, { status: 503 });
      const affected = changedProjects.filter((path) => snapshot.grant?.terms.projects.includes(path) && !snapshot.grant.revoked);
      if (affected.length) {
        try { await invalidateFoxGoalPolicy(affected); }
        catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "fox_policy_invalidation_failed" }, { status: 503 });
        }
      }
    }
    writeFoxServiceConfig(next);
    await storageRequest({ operation: "invalidate", topic: "operator-settings", keys: ["service"] });
    await startFoxService();
    try {
      await requestFoxServiceTick();
    } catch (error) {
      console.warn("[api/fox/service] immediate tick failed:", error);
    }

    return NextResponse.json(await foxServiceStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
