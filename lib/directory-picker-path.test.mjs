import assert from "node:assert/strict";
import test from "node:test";

// Dropping a filesystem root or splitting a POSIX backslash would navigate to
// a different folder than the breadcrumb the user clicked.
test("breadcrumbs retain POSIX, drive and UNC roots as navigable paths", async () => {
  const { getDirectoryBreadcrumbs } = await import("./directory-picker-path.ts");
  for (const [input, expected] of [
    ["/", [{ name: "/", path: "/" }]],
    ["/home/alex/project", [{ name: "/", path: "/" }, { name: "home", path: "/home" }, { name: "alex", path: "/home/alex" }, { name: "project", path: "/home/alex/project" }]],
    ["/projects/one\\two", [{ name: "/", path: "/" }, { name: "projects", path: "/projects" }, { name: "one\\two", path: "/projects/one\\two" }]],
    ["C:\\", [{ name: "C:", path: "C:\\" }]],
    ["C:\\Users\\Alex", [{ name: "C:", path: "C:\\" }, { name: "Users", path: "C:\\Users" }, { name: "Alex", path: "C:\\Users\\Alex" }]],
    ["D:/Projects/app", [{ name: "D:", path: "D:/" }, { name: "Projects", path: "D:/Projects" }, { name: "app", path: "D:/Projects/app" }]],
    ["\\\\server\\share\\app", [{ name: "\\\\server\\share", path: "\\\\server\\share\\" }, { name: "app", path: "\\\\server\\share\\app" }]],
    ["//server/share", [{ name: "//server/share", path: "//server/share/" }]],
  ]) assert.deepEqual(getDirectoryBreadcrumbs(input), expected, input);
});
