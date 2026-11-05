import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import {
  ModelsConfigConflictError,
  ModelsConfigParseError,
  maskModelsConfigSecrets,
  readModelsConfigFile,
  restoreModelsConfigSecrets,
  validateModelsConfig,
  writeModelsConfig,
  type ModelsFileConfig,
} from "@/lib/omp/models-config";
import { isUnresolvedSecretError } from "@/lib/secret-mask";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

// GET /api/models-config
// Returns the file's config with API keys and credential headers replaced by
// SECRET_MASK, plus `revision` (sha256 of the file bytes, "missing" when the file
// does not exist). Send the revision back with the PUT.
export async function GET() {
  const file = readModelsConfigFile();
  if (file.parseError) {
    // The editor must show the failure instead of an empty form — an empty
    // form invites a Save that would wipe the user's real providers.
    return NextResponse.json({
      providers: {},
      parseError: file.parseError,
      path: file.path,
      revision: file.revision,
      code: "models_config_unparseable",
    });
  }
  return NextResponse.json({ ...maskModelsConfigSecrets(file.config), revision: file.revision });
}

function readRenamedFrom(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) return undefined;
  return value as Record<string, string>;
}

// PUT /api/models-config[?overwrite=true]
// Body: { revision: string, config: ModelsFileConfig, renamedFrom?: Record<newName, oldName> }
// - 409 models_config_conflict: models.yml changed since `revision` was read.
// - 409 models_config_unparseable: models.yml is unparseable (unless ?overwrite=true).
// - 400 secret_placeholder_unresolved: a SECRET_MASK has no stored value to keep.
// Refuses to write while models.yml is unparseable unless ?overwrite=true. The
// previous file is kept as models.yml.bak.
export async function PUT(req: Request) {
  try {
    const overwriteUnparseable = new URL(req.url).searchParams.get("overwrite") === "true";
    const body: unknown = await req.json();
    if (!isRecord(body) || !isRecord(body.config)) {
      return NextResponse.json({ error: "config must be an object", code: "invalid_models_config" }, { status: 400 });
    }
    if (typeof body.revision !== "string" || !body.revision) {
      return NextResponse.json({ error: "revision is required", code: "models_config_revision_required" }, { status: 400 });
    }
    const renamedFrom = readRenamedFrom(body.renamedFrom);
    if (!renamedFrom) {
      return NextResponse.json({ error: "renamedFrom must map provider names to provider names", code: "invalid_models_config" }, { status: 400 });
    }

    const current = readModelsConfigFile();
    if (current.revision !== body.revision) return conflictResponse(current.path);

    let config: ModelsFileConfig;
    try {
      config = restoreModelsConfigSecrets(body.config as ModelsFileConfig, current.config, renamedFrom);
      validateModelsConfig(config);
    } catch (error) {
      const code = isUnresolvedSecretError(error) ? error.code : undefined;
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }, { status: 400 });
    }
    try {
      writeModelsConfig(config, { overwriteUnparseable, expectedRevision: current.revision });
    } catch (error) {
      if (error instanceof ModelsConfigConflictError) return conflictResponse(error.path);
      if (error instanceof ModelsConfigParseError) {
        return NextResponse.json(
          { error: `${error.message} — fix it by hand; foxnio will not overwrite it`, code: "models_config_unparseable" },
          { status: 409 },
        );
      }
      throw error;
    }
    invalidateModelsCache();
    // The utility process loads models.yml once at startup. A cache flush alone
    // would still query that stale registry after a provider was added.
    disposeUtilityRpc();
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function conflictResponse(path: string) {
  return NextResponse.json(
    { error: `${path} changed since it was loaded. Reload it before saving.`, code: "models_config_conflict" },
    { status: 409 },
  );
}
