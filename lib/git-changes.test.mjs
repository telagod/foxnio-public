import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("maps .gitattributes review attributes from real git check-attr output", async (t) => {
  const { GIT_REVIEW_ATTRIBUTES, parseGitCollapseReasons } = await loadSubject();
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-attrs-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // Keep the developer's global/system attributes out of the result.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", repo], { env });
  fs.writeFileSync(path.join(repo, ".gitattributes"), [
    "graph.json linguist-generated=true -diff",
    "gen/** linguist-generated",
    "build/** linguist-generated=true",
    "vendor/** linguist-vendored",
    "vendor/own.js linguist-vendored=false",
    "docs/** linguist-documentation",
    "docs/keep.md -linguist-documentation",
    "lock.txt -diff",
    "*.png binary",
    "",
  ].join("\n"));
  const paths = ["graph.json", "gen/a.ts", "build/out.js", "vendor/b.js", "vendor/own.js", "docs/c.md", "docs/keep.md", "lock.txt", "logo.png", "src/app.ts"];
  const output = execFileSync("git", ["-C", repo, "check-attr", "-z", "--stdin", ...GIT_REVIEW_ATTRIBUTES], {
    input: paths.map((p) => `${p}\0`).join(""),
    encoding: "utf8",
    env,
  });

  assert.deepEqual(Object.fromEntries(parseGitCollapseReasons(output)), {
    "graph.json": "no-diff",
    "gen/a.ts": "generated",
    "build/out.js": "generated",
    "vendor/b.js": "vendored",
    "docs/c.md": "documentation",
    "lock.txt": "no-diff",
  });
});

test("git status marks attribute files and -diff files get no synthesized patch", async (t) => {
  const { createJiti } = await import("jiti");
  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url).import("./git-changes.ts");
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  // getGitStatus/getGitFileDiff inherit process.env; isolate global/system attributes.
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  // `.native` expands Windows 8.3 names (RUNNER~1) so paths match `git rev-parse --show-toplevel`.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "git-attrs-diff-")));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "lock.txt -diff\ndocs/** linguist-documentation\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "lock.txt"), "hi\n");
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "hi\n");
  fs.writeFileSync(path.join(repo, "note.txt"), "hi\n");

  const status = await getGitStatus(repo);
  assert.deepEqual(
    Object.fromEntries(status.files.map((f) => [path.relative(repo, f.filePath), f.collapseReason ?? null])),
    { "lock.txt": "no-diff", [path.join("docs", "a.md")]: "documentation", "note.txt": null },
  );

  assert.deepEqual(await getGitFileDiff(repo, path.join(repo, "lock.txt")), { supported: false });
  const docs = await getGitFileDiff(repo, path.join(repo, "docs", "a.md"));
  assert.equal(docs.supported, true);
  assert.match(docs.patch, /^\+hi$/m);
  const note = await getGitFileDiff(repo, path.join(repo, "note.txt"));
  assert.equal(note.supported, true);
  assert.match(note.patch, /^\+hi$/m);
});

test("git status and diff treat a symlink alias of the project like its canonical path", async (t) => {
  const { createJiti } = await import("jiti");
  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url).import("./git-changes.ts");
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "git-symlink-")));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const repo = path.join(base, "projects", "example");
  const alias = path.join(base, "workspace", "example");
  const outside = path.join(base, "outside");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(repo, alias, "junction");
  } catch (error) {
    t.skip(`cannot create directory symlinks: ${error.code}`);
    return;
  }
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(outside, path.join(repo, "escape"), "junction");

  const names = (status, cwd) => status.files.map((f) => path.relative(cwd, f.filePath)).sort();
  const expected = ["b.txt", "escape", path.join("src", "a.txt")];

  const canonicalStatus = await getGitStatus(repo);
  assert.deepEqual(names(canonicalStatus, repo), expected);

  // Same files through the alias, reported in the alias namespace so the client's
  // cwd-relative display, explorer matching and /api/git/diff requests keep working.
  const aliasStatus = await getGitStatus(alias);
  assert.equal(aliasStatus.isGitRepository, true);
  assert.deepEqual(names(aliasStatus, alias), expected);
  assert.ok(aliasStatus.files.every((f) => f.filePath.startsWith(`${alias}${path.sep}`)));

  // A subdirectory alias still scopes the listing to that subdirectory.
  const subAlias = path.join(base, "workspace", "src-alias");
  fs.symlinkSync(path.join(repo, "src"), subAlias, "junction");
  assert.deepEqual(names(await getGitStatus(subAlias), subAlias), ["a.txt"]);

  for (const file of aliasStatus.files.filter((f) => f.filePath.endsWith(".txt"))) {
    const diff = await getGitFileDiff(alias, file.filePath);
    assert.equal(diff.supported, true, file.filePath);
    assert.match(diff.patch, /^\+two$/m);
    assert.deepEqual(diff, await getGitFileDiff(repo, path.join(repo, path.relative(alias, file.filePath))));
  }
  // Canonical file path with an alias cwd, and the reverse.
  assert.equal((await getGitFileDiff(alias, path.join(repo, "b.txt"))).supported, true);
  assert.equal((await getGitFileDiff(repo, path.join(alias, "b.txt"))).supported, true);

  // A symlink that leaves the repository is never followed.
  assert.deepEqual(await getGitFileDiff(repo, path.join(repo, "escape", "secret.txt")), { supported: false });
  assert.deepEqual(await getGitFileDiff(alias, path.join(alias, "escape", "secret.txt")), { supported: false });
  assert.deepEqual(await getGitFileDiff(alias, path.join(alias, "escape")), { supported: false });
  assert.deepEqual(await getGitFileDiff(alias, path.join(outside, "secret.txt")), { supported: false });
  assert.deepEqual(await getGitFileDiff(alias, path.join(alias, "..", "outside", "secret.txt")), { supported: false });
});
