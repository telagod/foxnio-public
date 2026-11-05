import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir, getConfigRoot } from "./omp/paths";
import { isWindowsAbsolutePath } from "./paths";
import { listAllSessions } from "./session-reader";

export { isWindowsAbsolutePath } from "./paths";

// Allowed roots — in-memory plus session-derived, globalThis for hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return stripLongPathPrefix(filePath.replace(/\\/g, "/"));
}

/** Windows device paths (\\?\C:\... , \\?\UNC\server\share\...) come back from
 *  realpathSync and defeat plain startsWith prefix checks against ordinary
 *  drive/UNC roots, producing false 403s on long paths and junctions. */
function stripLongPathPrefix(filePath: string): string {
  if (filePath.startsWith("//?/UNC/")) return "//" + filePath.slice(8);
  if (filePath.startsWith("//?/")) return filePath.slice(4);
  if (filePath.startsWith("\\\\?\\UNC\\")) return "\\\\" + filePath.slice(8);
  if (filePath.startsWith("\\\\?\\")) return filePath.slice(4);
  return filePath;
}

function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) globalThis.__piAdditionalAllowedRoots = new Set();
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const n = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(n);
  globalThis.__piAllowedRootsCache?.roots.add(n);
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

/**
 * omp's own config/agent roots: the config root (`~/.omp`, or whatever
 * `PI_CONFIG_DIR` renamed it to), the agent state dir (`~/.omp/agent`, or
 * `PI_CODING_AGENT_DIR`), and the ecosystem-standard agent rule/skill provider
 * dirs `~/.agents` and `~/.agent`. Global instruction files omp loads itself
 * (`~/.agents/AGENTS.md`, `~/.omp/agent/...`) used to 403 in the file viewer
 * because only workspaces were allowed roots (#135).
 *
 * Derived from lib/omp/paths.ts rather than re-implemented, so the
 * PI_CONFIG_DIR / PI_CODING_AGENT_DIR / XDG rules stay in one place.
 * A directory that does not exist is harmless: isPathWithinRoots is a pure
 * string-prefix check and existingPathWithinRootsChecker() already swallows
 * realpathSync failures for stale roots.
 */
export function getConfigAgentRoots(): string[] {
  return [
    getConfigRoot(),
    getAgentDir(),
    path.join(homedir(), ".agents"),
    path.join(homedir(), ".agent"),
  ].map(normalizeSlashes);
}

/**
 * Files inside the omp config/agent roots that must stay unreadable through the
 * generic file API even though their directory is an allowed root (#135).
 *
 * Making the config root readable to view a rule file would otherwise hand out
 * every secret stored beside it, including over `?type=download`:
 *  - `agent.db`: omp's credential store (API keys).
 *  - `models.yml`: can carry an `apiKey` for custom models.
 *  - `omp-web-settings.json`: omp-web's settings, including `agentEnv` API keys.
 *  - `notifications.db`: omp-web's push store, holding the VAPID private key.
 *  - `web-auth-secret.json`: the key that signs web session cookies.
 *  - `broker.token`: bearer token of an omp daemon (`run/daemons/<id>/`).
 *  - `mcp.json`: MCP server definitions with `env`/`headers` credentials.
 * The ones with a purpose-built route (`app/api/auth/api-key/*`,
 * `app/api/models-config/route.ts`, `app/api/mcp/route.ts`) are redacted or
 * scoped there, so nothing legitimate needs the generic path.
 *
 * Matching is by file-name prefix, so SQLite sidecars (`agent.db-wal`,
 * `agent.db-shm`, `agent.db-journal`) and editor/atomic-write leftovers
 * (`mcp.json.bak`, `omp-web-settings.json.tmp`) are denied with their main file.
 */
const CONFIG_ROOT_DENIED_PREFIXES: readonly string[] = [
  "agent.db",
  "models.yml",
  "omp-web-settings.json",
  "notifications.db",
  "web-auth-secret.json",
  "broker.token",
  "mcp.json",
];

/** Name-based test on the path as given; callers decide whether the path is under a config root. */
export function isConfigRootDeniedFile(filePath: string): boolean {
  const base = normalizeSlashes(filePath);
  const name = base.slice(base.lastIndexOf("/") + 1).toLowerCase();
  return CONFIG_ROOT_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** True when `filePath` lives under one of the omp config/agent roots. */
function isUnderConfigRoot(filePath: string, configRoots: readonly string[]): boolean {
  const target = normalizeSlashes(filePath);
  return configRoots.some((root) => isPathWithinRoots(target, new Set([normalizeSlashes(root)])));
}

function realPathOrNull(filePath: string): string | null {
  try {
    return normalizeSlashes(realpathSync.native(filePath));
  } catch {
    return null;
  }
}

/**
 * True when `filePath` is, or resolves through symlinks to, a protected file
 * under a config root. The requested path alone is not enough: a symlink inside
 * an allowed project pointing at `~/.omp/agent/agent.db` has an innocent name
 * and location. Config roots are compared in both lexical and resolved form
 * because `~/.omp` itself may be a symlink (dotfile managers).
 */
export function isConfigRootCredentialPath(filePath: string): boolean {
  const configRoots = getConfigAgentRoots();
  const roots = [...configRoots];
  for (const root of configRoots) {
    const resolved = realPathOrNull(root);
    if (resolved) roots.push(resolved);
  }
  const resolvedTarget = realPathOrNull(filePath);
  return [filePath, ...(resolvedTarget ? [resolvedTarget] : [])]
    .some((candidate) => isUnderConfigRoot(candidate, roots) && isConfigRootDeniedFile(candidate));
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;
  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }
  for (const root of getAdditionalAllowedRoots()) roots.add(root);
  // Config roots are appended LAST: a relative request must fan out over real
  // workspaces (session cwds, project roots, allowFileRoot() roots) before it
  // can land in ~/.omp or ~/.agents.
  for (const root of getConfigAgentRoots()) roots.add(root);
  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const n = resolver.resolve(target);
    const nr = resolver.resolve(root);
    const c = useWindowsRules ? n.toLowerCase() : n;
    const cr = useWindowsRules ? nr.toLowerCase() : nr;
    const withSep = cr.endsWith(sep) ? cr : cr + sep;
    if (c === cr || c.startsWith(withSep)) return true;
  }
  return false;
}

export const isFilePathAllowed = isPathWithinRoots;

/** An /api/files request path is absolute when it is a posix `/…` root, a
 *  Windows drive `C:/…` path, or a UNC `//server/share…` path. Everything else
 *  is relative and only becomes meaningful once resolved against a root. */
export function isAbsoluteFileRequestPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath);
  return normalized.startsWith("/") || isWindowsAbsolutePath(normalized);
}

/**
 * Resolve a *relative* /api/files request path against the allowed roots.
 *
 * `components/MarkdownBody.tsx` linkifies bare workspace paths (`package.json`,
 * `src/foo.ts`) into `/api/files/<encoded>?type=read`, but the catch-all param
 * carries no leading slash, so the route read those as `/package.json` — a path
 * at the filesystem root, in no allowed root, and a 403 (#135).
 *
 * Candidates are tried in allowed-roots Set order (session cwds, then project
 * roots, then allowFileRoot() roots, then the config roots) and the first one
 * that (a) stays inside the root that produced it and (b) exists on disk wins.
 * A `../..` escape resolves out of its root and fails the same prefix check
 * that guards absolute requests, so traversal is rejected identically.
 *
 * Returns null for an absolute request (nothing to resolve) and for a relative
 * one that matches no in-root candidate. Callers must keep their absolute
 * authorization in place — this only ever widens *which in-root path* a
 * relative name maps to, never past a root.
 */
export function resolveRequestedFilePath(requestPath: string, roots: Set<string>): string | null {
  const request = normalizeSlashes(requestPath);
  // Checked before any trimming: a UNC `//server/share` request is absolute,
  // not a relative path with a doubled slash.
  if (!request || isAbsoluteFileRequestPath(request)) return null;
  const relative = request.replace(/^\/+/, "");
  if (!relative) return null;
  for (const root of roots) {
    // Mirror isPathWithinRoots' resolver choice so a Windows-style root stays
    // Windows-style even when the strings are built on another platform.
    const useWindowsRules = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(relative);
    const resolver = useWindowsRules ? path.win32 : path;
    const candidate = resolver.resolve(root, relative);
    // The candidate is checked against the ONE root that produced it, never
    // against the whole set: `path.resolve(root, "../..")` escapes that root.
    if (!isPathWithinRoots(candidate, new Set([root]))) continue;
    if (!existsSync(candidate)) continue;
    return normalizeSlashes(candidate);
  }
  return null;
}

/** isExistingPathWithinRoots for many targets: realpaths the roots once. */
export function existingPathWithinRootsChecker(roots: Set<string>): (target: string) => boolean {
  const realRoots = new Set<string>();
  for (const root of roots) { try { realRoots.add(stripLongPathPrefix(realpathSync(root))); } catch { /* stale */ } }
  return (target) => {
    let realTarget: string;
    try { realTarget = stripLongPathPrefix(realpathSync(target)); } catch { return false; }
    return isPathWithinRoots(realTarget, realRoots);
  };
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  return existingPathWithinRootsChecker(roots)(target);
}

export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
