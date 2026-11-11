import { comparableProjectPath } from "./comparable-path";
import type { ProjectRegistryFile } from "./project-registry";
import type { ManagedProject } from "./types";

/** Merge canonical display identities; never authorizes filesystem or native actions. */
export function mergeCanonicalProjects(registry: ProjectRegistryFile, discovered: Iterable<string>): ManagedProject[] {
  const hidden = new Set(registry.projects.filter((entry) => entry.hidden).map((entry) => comparableProjectPath(entry.path)));
  const registered: ManagedProject[] = [];
  const seen = new Set<string>();
  for (const entry of registry.projects.filter((project) => !project.hidden).sort((a, b) => {
    const aOrder = a.sortOrder ?? Number.POSITIVE_INFINITY;
    const bOrder = b.sortOrder ?? Number.POSITIVE_INFINITY;
    return aOrder !== bOrder ? aOrder - bOrder : b.addedAt.localeCompare(a.addedAt);
  })) {
    const key = comparableProjectPath(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    registered.push({ path: entry.path, addedAt: entry.addedAt, alias: entry.alias, sortOrder: entry.sortOrder, pinOrder: entry.pinOrder, launchConfig: entry.launchConfig });
  }
  const extra: ManagedProject[] = [];
  for (const path of discovered) {
    if (!path) continue;
    const key = comparableProjectPath(path);
    if (hidden.has(key) || seen.has(key)) continue;
    seen.add(key);
    extra.push({ path });
  }
  extra.sort((a, b) => a.path.localeCompare(b.path));
  return [...registered, ...extra];
}
