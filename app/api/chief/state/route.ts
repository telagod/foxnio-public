import { foxNativeOnlyResponse } from "@/lib/fox-legacy-api";

export const dynamic = "force-dynamic";

export async function GET() {
  // Historical control-plane records remain untouched by page reads.
  return foxNativeOnlyResponse();
}
