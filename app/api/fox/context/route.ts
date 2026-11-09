import { join } from "path";
import { NextResponse } from "next/server";
import type { Briefing } from "@/lib/briefing";
import { formatFoxBriefing } from "@/lib/fox";
import { ensureFoxWorkspace } from "@/lib/fox-workspace";
import { isRecord } from "@/lib/type-guards";
import { loadBriefingSnapshot } from "@/lib/briefing-server";
import { writeFileAtomic } from "@/lib/fs-atomic";

export const dynamic = "force-dynamic";

const MAX_CONTEXT_BYTES = 512 * 1024;

/**
 * POST /api/fox/context
 *
 * Refreshes the server's current 7-day briefing in FOX's cwd as
 * BRIEFING.md. The resident chat reads that file, so its status answers match
 * what the user sees instead of counting every historical session on disk.
 */
export async function POST(request: Request) {
  try {
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_CONTEXT_BYTES) {
      return NextResponse.json({ error: "Context is too large", code: "context_too_large" }, { status: 413 });
    }
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || !isRecord(body.briefing)) {
      return NextResponse.json({ error: "A briefing object is required", code: "briefing_required" }, { status: 400 });
    }
    const briefing = body.briefing as unknown as Briefing;
    if (
      typeof briefing.generatedAt !== "string"
      || !isRecord(briefing.totals)
      || !Array.isArray(briefing.needsYou)
      || !Array.isArray(briefing.projects)
      || !Array.isArray(briefing.recent)
    ) {
      return NextResponse.json({ error: "Briefing shape is invalid", code: "briefing_invalid" }, { status: 400 });
    }

    const dir = ensureFoxWorkspace();
    const current = (await loadBriefingSnapshot({ days: 7 })).briefing;
    writeFileAtomic(join(dir, "BRIEFING.md"), formatFoxBriefing(current));
    return NextResponse.json(
      { ok: true, updatedAt: current.generatedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[api/fox/context]", error);
    return NextResponse.json({ error: "Could not update FOX context", code: "fox_context_failed" }, { status: 500 });
  }
}
