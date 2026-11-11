import { NextResponse, type NextRequest } from "next/server";
import { loadBriefingSnapshot } from "@/lib/briefing-server";
import { apiErrorResponse } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

function daysFromQuery(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(30, Math.max(1, parsed)) : 7;
}

/**
 * Read-only cross-project briefing. The load helper never starts an agent,
 * never writes OMP state, and never reads session transcripts; it composes the
 * existing list/live/notification/registry views.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const { briefing } = await loadBriefingSnapshot({
      days: daysFromQuery(params.get("days")),
      excludeSessionId: params.get("excludeSession"),
      now: Date.now(),
    });
    return NextResponse.json(briefing, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
