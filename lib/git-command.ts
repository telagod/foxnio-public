import { execFile } from "child_process";
import { promisify } from "util";
import { createChildProcessEnvironment } from "./project-command-env";

const execFileAsync = promisify(execFile);

/**
 * Global git options placed before the subcommand. The repositories we inspect
 * are untrusted: a copied or extracted checkout carries its own `.git/config`.
 *
 *  - `core.fsmonitor=false`: otherwise `git status`/`git diff` execute the
 *    command the repo's config names as its filesystem monitor.
 *  - `--no-optional-locks`: `git status` otherwise refreshes the index and
 *    takes `index.lock`, which makes an agent's concurrent `git add`/`commit`
 *    fail with "index.lock exists" whenever the explorer polls status.
 *  - `--literal-pathspecs`: a file named `*.txt` must select itself, not every
 *    `.txt` file.
 */
const READ_ONLY_GLOBAL_OPTIONS: readonly string[] = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
];

/** Mutations still must not run a repo-configured fsmonitor (`worktree remove` runs `git status`). */
const MUTATING_GLOBAL_OPTIONS: readonly string[] = ["-c", "core.fsmonitor=false"];

export type GitCommandMode = "read-only" | "mutating";

export interface GitCommand {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Argument vector and environment for running git against `cwd`.
 *
 * `read-only` is for commands that must not modify the repository or run
 * repo-configured programs. Callers using `diff` MUST still pass
 * `--no-ext-diff --no-textconv`: those are subcommand options, not global ones.
 * `LC_ALL=C` pins the message locale so error-text matching is stable.
 */
export function buildGitCommand(cwd: string, args: readonly string[], mode: GitCommandMode = "read-only"): GitCommand {
  if (mode === "read-only") {
    return {
      args: ["-C", cwd, ...READ_ONLY_GLOBAL_OPTIONS, ...args],
      env: createChildProcessEnvironment({ LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }),
    };
  }
  return {
    args: ["-C", cwd, ...MUTATING_GLOBAL_OPTIONS, ...args],
    env: createChildProcessEnvironment({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }),
  };
}

export interface ExecGitOptions {
  timeout: number;
  maxBuffer: number;
  mode?: GitCommandMode;
}

/** Runs git through {@link buildGitCommand}. The returned promise exposes `.child` for stdin piping. */
export function execGit(cwd: string, args: readonly string[], options: ExecGitOptions) {
  const command = buildGitCommand(cwd, args, options.mode);
  return execFileAsync("git", command.args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: command.env,
  });
}
