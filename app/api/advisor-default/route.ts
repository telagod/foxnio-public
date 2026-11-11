import { NextResponse } from "next/server";
import { resolveAdvisorDefault } from "@/lib/advisor-default";
import { readAdvisorEnabled } from "@/lib/omp/settings-config";
import { launchConfigForCwd } from "@/lib/rpc-manager";
import { apiErrorResponse } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

// GET /api/advisor-default?cwd=<workspace>  →  { enabled, ompConfig, project }
// The advisor state a chat in `cwd` starts with before anyone touches the
// per-chat toggle: omp's own `advisor.enabled` and the workspace launch config.
// A workspace launched with `--profile` runs omp against that profile's own
// config.yml, so that is the file whose `advisor.enabled` counts.
export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd");
    const launchConfig = cwd ? await launchConfigForCwd(cwd) : undefined;
    const ompConfig = readAdvisorEnabled(launchConfig?.profile);
    return NextResponse.json(resolveAdvisorDefault({ ompConfig, project: launchConfig?.advisor }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
