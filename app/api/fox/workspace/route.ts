import { NextResponse } from "next/server";
import { ensureFoxWorkspace } from "@/lib/fox-workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/fox/workspace → `{ cwd }`
 *
 * Ensures FOX's normal OMP cwd exists and has its persona. This is the only
 * write the Fox UI performs outside the project workspaces, and it happens once.
 */
export async function GET() {
  try {
    return NextResponse.json(
      { cwd: ensureFoxWorkspace() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[api/fox/workspace]", error);
    return NextResponse.json(
      { error: "Could not prepare the FOX workspace", code: "fox_workspace_failed" },
      { status: 500 },
    );
  }
}
