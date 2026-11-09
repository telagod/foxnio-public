import { NextResponse } from "next/server";

export function foxNativeOnlyResponse() {
  return NextResponse.json({
    error: "FOX now uses native OMP plans, memory and confirmation dialogs. Historical Chief records are preserved but cannot execute actions.",
    code: "fox_native_only",
  }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
