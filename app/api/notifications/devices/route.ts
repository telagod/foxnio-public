import { NextResponse } from "next/server";

function retired() {
  return NextResponse.json({ error: "Notifications are managed by FOX.", code: "notifications_managed_by_fox" }, { status: 410 });
}

export const GET = retired;
export const PUT = retired;
