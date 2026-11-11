import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join, relative, isAbsolute } from "path";
import { execGit } from "./git-command";
import { samePath, toNativePath } from "./paths";

export interface ProjectInfo {
  projectRoot: string;
  branch: string | null;
  isWorktree: boolean;
  isTopLevel: boolean;
}

export function realPathOrSelf(filePath: string): string {
  try { return realpathSync.native(filePath); } catch { return filePath; }
}

function inferRemovedWorktree(cwd: string, projects: readonly { path: string }[]): ProjectInfo | null {
  const inferred = (root: string): ProjectInfo => ({
    projectRoot: realPathOrSelf(root), branch: basename(cwd), isWorktree: true, isTopLevel: true,
  });
  const parent = dirname(cwd);
  if (parent.endsWith("-worktrees")) {
    const root = parent.slice(0, -"-worktrees".length);
    if (root && existsSync(join(root, ".git"))) return inferred(root);
  }
  for (const project of projects) {
    if (!existsSync(join(project.path, ".git"))) continue;
    const rel = relative(`${project.path}-worktrees`, cwd);
    if (rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)) {
      return inferred(project.path);
    }
    const directory = join(project.path, ".git", "worktrees");
    try {
      for (const entry of readdirSync(directory)) {
        try {
          const gitdir = toNativePath(readFileSync(join(directory, entry, "gitdir"), "utf8").trim());
          if (samePath(dirname(gitdir), cwd) || samePath(gitdir, cwd)) return inferred(project.path);
        } catch { /* A pruned worktree may vanish during resolution. */ }
      }
    } catch { /* Repositories need not have linked worktrees. */ }
  }
  return null;
}

/** Display grouping only. No registry/client imports and no permission side effects. */
export async function resolveProjectWithRegistry(cwd: string, registeredProjects: readonly { path: string }[]): Promise<ProjectInfo> {
  if (!cwd) return { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
  const fallback = (): ProjectInfo => inferRemovedWorktree(cwd, registeredProjects) ?? {
    projectRoot: realPathOrSelf(cwd), branch: null, isWorktree: false, isTopLevel: false,
  };
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    const inferred = inferRemovedWorktree(cwd, registeredProjects);
    if (inferred) return inferred;
    if (!existsSync(cwd)) return fallback();
  }
  try {
    const { stdout } = await execGit(cwd, [
      "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel", "--abbrev-ref", "HEAD",
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, mode: "read-only" });
    const [commonRaw, gitRaw, topRaw, ref] = stdout.trim().split("\n").map(line => line.trim());
    if (!commonRaw || !gitRaw || !topRaw) return fallback();
    const [common, git, top] = [commonRaw, gitRaw, topRaw].map(value => realPathOrSelf(toNativePath(value)));
    const realCwd = realPathOrSelf(cwd);
    const isTopLevel = samePath(top, realCwd);
    const isWorktree = isTopLevel && !samePath(git, common);
    return {
      projectRoot: isTopLevel ? realPathOrSelf(isWorktree ? dirname(common) : top) : realCwd,
      branch: ref && ref !== "HEAD" ? ref : null,
      isWorktree,
      isTopLevel,
    };
  } catch { return fallback(); }
}
