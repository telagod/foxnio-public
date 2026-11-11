import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** BRIEFING.md is materialized by the server data runtime, never browser input. */
export async function POST() {
  return NextResponse.json({ error: "FOX context is maintained by the server data runtime.", code: "fox_context_server_owned" }, { status: 410 });
}
