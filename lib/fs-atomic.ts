import { randomBytes } from "crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/** Mode of a file this module creates. Config files here can carry API keys or
 * bearer tokens, so a new file is owner-only unless the caller says otherwise. */
const NEW_FILE_MODE = 0o600;
const MAX_SYMLINK_DEPTH = 32;

export interface AtomicWriteOptions {
  /** Mode for a newly created file (default 0o600). */
  mode?: number;
  /** Keep the mode of an existing target instead of `mode` (default true). */
  preserveMode?: boolean;
  /** Keep the previous contents in `<target>.bak` (same mode as the previous file)
   * before replacing them. Skipped when the contents do not change. */
  backup?: boolean;
}

/** Follow symlinks so a dotfile-manager link keeps pointing at its target after
 * a save (`rename` onto the link would replace the link with a regular file).
 * A dangling link resolves to the path it points at. */
export function resolveWriteTarget(path: string): string {
  let current = resolve(path);
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }
    if (!isLink) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`Too many levels of symbolic links: ${path}`);
}

/**
 * Replace `path` with `data` without ever exposing a partial file: the bytes go
 * to a temp file next to the target, which is created with an explicit mode (the
 * existing file's mode, else 0o600) and then renamed over the target. The temp
 * file is removed if any step fails. Returns the path actually written (the
 * symlink target when `path` is a link).
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): string {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });

  let mode = options.mode ?? NEW_FILE_MODE;
  let previous: Buffer | undefined;
  if (existsSync(target)) {
    if (options.preserveMode !== false) mode = statSync(target).mode & 0o7777;
    if (options.backup) previous = readFileSync(target);
  }
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (previous && !previous.equals(bytes)) {
    writeFileAtomic(`${target}.bak`, previous, { mode, preserveMode: false });
  }

  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd: number | undefined;
  try {
    // "wx" refuses to follow or reuse anything already at the temp path.
    fd = openSync(temp, "wx", mode);
    // The mode passed to open is masked by the process umask; set it exactly.
    if (process.platform !== "win32") fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    rmSync(temp, { force: true });
    throw error;
  }
  return target;
}
