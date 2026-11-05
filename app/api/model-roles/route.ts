import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles, updateModelRoles } from "@/lib/omp/model-roles";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json(readModelRoles());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}

// PUT /api/model-roles
// Body: { changes: Record<role, selector> }. A non-empty selector sets that role,
// an empty one removes it, and roles not named stay as they are on disk. Answers
// with the resulting roles.
export async function PUT(request: Request) {
  try {
    const body: unknown = await request.json();
    const changes = isRecord(body) ? body.changes : undefined;
    if (!isRecord(changes) || Object.values(changes).some((selector) => typeof selector !== "string")) {
      return NextResponse.json({ error: "changes must map role names to model selectors (empty to remove)" }, { status: 400 });
    }
    const named = Object.entries(changes as Record<string, string>).map(([role, selector]) => [role.trim(), selector] as const);
    if (named.some(([role]) => !role)) {
      return NextResponse.json({ error: "role names must not be empty" }, { status: 400 });
    }
    const roles = updateModelRoles(Object.fromEntries(named));
    invalidateModelsCache();
    return NextResponse.json({ success: true, roles });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
