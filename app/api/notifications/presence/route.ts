import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json({ error: "Notifications are managed by FOX.", code: "notifications_managed_by_fox" }, { status: 410 });
}
