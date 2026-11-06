import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";
import { createChildProcessEnvironment } from "@/lib/project-command-env";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

/**
 * The exported page embeds message text as raw HTML (omp renders markdown
 * without sanitizing it) and runs its own scripts. Served from the app origin
 * it could call every API with the user's cookie, so it must live in an opaque
 * origin: `sandbox` without `allow-same-origin`. The page still needs its
 * scripts and may open links. next.config.ts keeps the global CSP off this path
 * (config headers would overwrite this one) and repeats these values.
 */
const EXPORT_DOCUMENT_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Render a session to HTML by shelling out to the user's omp binary:
 * `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 * Since omp 18.14 the page is not self-contained: it loads its viewer, marked
 * and highlight.js from stencil.so (SRI-pinned, CORS `*`, so the sandboxed
 * opaque origin can still run them), and needs network access to render.
 */
async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const bin = resolveOmpBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  await execFileAsync(bin, ["--export", filePath, outputPath], {
    cwd: tmpdir(),
    env: createChildProcessEnvironment(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `omp-session-${sessionBase}.html`;
    // Private per-request directory (mode 0700): a fixed shared directory under
    // the system temp dir could be pre-created or watched by another local user.
    const tempDir = mkdtempSync(join(tmpdir(), "omp-web-export-"));
    const outputPath = join(tempDir, "session.html");

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      return new Response(html, {
        headers: {
          ...EXPORT_DOCUMENT_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline, "session.html"),
          "Cache-Control": "no-cache",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("omp binary not found")) {
      return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
}
