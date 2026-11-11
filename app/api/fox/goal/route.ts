import { NextResponse } from "next/server";
import { getFoxGoalSnapshot, controlFoxGoal } from "@/lib/fox-goal-service";

export const dynamic = "force-dynamic";

// Authentication, Origin and Host protection is the same proxy boundary as
// every other agent API. This endpoint never accepts a grant or arbitrary RPC.
export async function GET() {
  try {
    return NextResponse.json(await getFoxGoalSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read FOX goal" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > 1024) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return NextResponse.json({ error: "Request body too large" }, { status: 413 }); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !["pause", "resume", "stop"].includes(body.action)) {
      return NextResponse.json({ error: "Expected action: pause, resume or stop" }, { status: 400 });
    }
    return NextResponse.json(await controlFoxGoal(body.action), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Native goal control failed" }, { status: error instanceof SyntaxError ? 400 : 409 });
  } finally { reader?.releaseLock(); }
}
