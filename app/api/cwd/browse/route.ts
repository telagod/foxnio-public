import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { stat } from "fs/promises";
import {
  createChildDirectory,
  DirectoryCreationError,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";

// GET /api/cwd/browse?path=... — lists readable subdirectories in the filesystem.
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();
    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({ path: "", parentPath: null, drives: await listWindowsDrives(), directories: [] });
    }
    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist", code: "directory_not_found" }, { status: 404 });
    }


    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory", code: "not_a_directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/cwd/browse { parent, name } — create one folder, without registering a project.
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
    }
    const { parent, name } = body as Record<string, unknown>;
    if (typeof parent !== "string" || !parent.trim()) {
      return NextResponse.json({ error: "A parent directory is required", code: "path_required" }, { status: 400 });
    }
    if (typeof name !== "string") {
      return NextResponse.json({ error: "Enter a single valid folder name", code: "invalid_directory_name" }, { status: 400 });
    }
    return NextResponse.json({ path: await createChildDirectory(parent, name) }, { status: 201 });
  } catch (error) {
    if (error instanceof DirectoryCreationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
