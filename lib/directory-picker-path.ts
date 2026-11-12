export function getDirectoryBreadcrumbs(directory: string): { name: string; path: string }[] {
  if (!directory) return [];
  const windows = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\") || directory.startsWith("//");
  const separator = windows && directory.includes("\\") ? "\\" : "/";
  const normalized = windows ? directory.replace(/\\/g, "/") : directory;
  const root = normalized.match(/^[a-zA-Z]:\//)?.[0]
    ?? (windows ? normalized.match(/^\/\/[^/]+\/[^/]+\/?/)?.[0].replace(/\/?$/, "/") : undefined)
    ?? "/";
  const native = (value: string) => separator === "\\" ? value.replace(/\//g, "\\") : value;
  const crumbs = [{ name: root === "/" ? root : native(root.slice(0, -1)), path: native(root) }];
  let path = root;
  for (const name of normalized.slice(root.length).split("/").filter(Boolean)) {
    path += `${path.endsWith("/") ? "" : "/"}${name}`;
    crumbs.push({ name, path: native(path) });
  }
  return crumbs;
}
