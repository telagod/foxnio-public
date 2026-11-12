import * as fsPromises from "fs/promises";
import { homedir } from "os";
import path from "path";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await fsPromises.stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));
  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (directory.startsWith("~/")) return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : directory.startsWith("/") ? path.posix : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return fsPromises.realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  // Keep the directory argument opaque to Next's NFT build tracer. This is a
  // user-selected path and must only be inspected at request time; tracing it
  // as a static glob would walk the entire Windows profile during `next build`.
  const readDirectory = Reflect.get(fsPromises, "readdir") as typeof fsPromises.readdir;
  const entries = await readDirectory(directory, { withFileTypes: true });
  // Skip broken, inaccessible, or non-directory symlinks.
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await fsPromises.realpath(entryPath);
      const entryStat = await fsPromises.stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export class DirectoryCreationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Create one empty child only; existing files, directories and links are never replaced. */
export async function createChildDirectory(parent: string, name: string): Promise<string> {
  const childName = name.trim();
  if (!childName || childName === "." || childName === ".." || /[/\\\p{Cc}]/u.test(childName)
    || (process.platform === "win32" && (/[<>:"|?*]/.test(childName) || /[. ]$/.test(childName)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(childName)))) {
    throw new DirectoryCreationError("invalid_directory_name", "Enter a single valid folder name", 400);
  }
  if (!parent.trim()) throw new DirectoryCreationError("path_required", "A parent directory is required", 400);
  if (parent.includes("\0")) throw new DirectoryCreationError("invalid_path", "Invalid parent directory", 400);
  try {
    const resolvedParent = await resolveDirectory(parent.trim());
    if (!(await fsPromises.stat(resolvedParent)).isDirectory()) {
      throw new DirectoryCreationError("not_a_directory", "Path is not a directory", 400);
    }
    const childPath = path.join(resolvedParent, childName);
    await fsPromises.mkdir(childPath);
    return childPath;
  } catch (error) {
    if (error instanceof DirectoryCreationError) throw error;
    switch ((error as NodeJS.ErrnoException).code) {
      case "EEXIST": throw new DirectoryCreationError("directory_exists", "A file or folder with this name already exists", 409);
      case "ENOENT": throw new DirectoryCreationError("directory_not_found", "Directory does not exist", 404);
      case "ENOTDIR": throw new DirectoryCreationError("not_a_directory", "Path is not a directory", 400);
      case "EACCES":
      case "EPERM":
      case "EROFS": throw new DirectoryCreationError("access_denied", "Cannot create a folder here: access denied or read-only filesystem", 403);
      case "ENAMETOOLONG":
      case "EINVAL": throw new DirectoryCreationError("invalid_directory_name", "Enter a single valid folder name", 400);
      default: throw error;
    }
  }
}
