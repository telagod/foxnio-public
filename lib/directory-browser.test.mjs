import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

test("lists directories and directory symlinks without returning files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    try {
      await symlink(path.join(root, "project"), path.join(root, "linked-project"));
    } catch (error) {
      // Windows without Developer Mode/admin rights cannot create symlinks.
      if (error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const { getBrowseStartDirectory, normalizeDirectory, resolveDirectory, shouldShowWindowsDrivePicker, getWindowsDriveCandidates } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.deepEqual(getWindowsDriveCandidates().at(0), { name: "A:", path: "A:\\" });
  assert.deepEqual(getWindowsDriveCandidates().at(-1), { name: "Z:", path: "Z:\\" });
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `omp-web-missing-${Date.now()}`)));
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});

// These exercise actual filesystem effects: recursive mkdir, missing validation
// or overwrite-on-conflict would all change observable user content.
test("creates exactly one empty child under the canonical selected parent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    const created = await createChildDirectory(root, "  中文项目  ");
    assert.equal(created, path.join(await realpath(root), "中文项目"));
    assert.deepEqual(await readdir(root), ["中文项目"]);
    assert.deepEqual(await readdir(created), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid child names without escaping or changing the parent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    for (const name of ["", "  ", ".", "..", "../escape", "nested/child", "nested\\child", "/absolute", "C:\\absolute", "bad\u0000name", "bad\nname"]) {
      await assert.rejects(() => createChildDirectory(root, name), { code: "invalid_directory_name", status: 400 }, JSON.stringify(name));
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing directories and files are never overwritten by creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    await mkdir(path.join(root, "existing"));
    await writeFile(path.join(root, "existing", "keep.txt"), "keep directory content");
    await writeFile(path.join(root, "file"), "keep file content");
    for (const name of ["existing", "file"]) await assert.rejects(createChildDirectory(root, name), { code: "directory_exists", status: 409 });
    assert.equal(await readFile(path.join(root, "existing", "keep.txt"), "utf8"), "keep directory content");
    assert.equal(await readFile(path.join(root, "file"), "utf8"), "keep file content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves symlink parents but never replaces an existing symlink", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    await mkdir(path.join(root, "actual"));
    try {
      await symlink(path.join(root, "actual"), path.join(root, "alias"), "dir");
      await symlink(path.join(root, "missing"), path.join(root, "broken"));
    } catch (error) {
      if (error?.code === "EPERM") return t.skip("Symbolic links require additional privileges");
      throw error;
    }
    const { createChildDirectory } = await loadSubject();
    assert.equal(await createChildDirectory(path.join(root, "alias"), "child"), path.join(await realpath(root), "actual", "child"));
    assert.deepEqual(await readdir(path.join(root, "actual", "child")), []);
    await assert.rejects(createChildDirectory(root, "broken"), { code: "directory_exists", status: 409 });
    assert.equal((await lstat(path.join(root, "broken"))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or non-directory parents do not create intermediate directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    await writeFile(path.join(root, "file"), "keep");
    await assert.rejects(createChildDirectory(path.join(root, "missing"), "child"), { code: "directory_not_found", status: 404 });
    await assert.rejects(createChildDirectory(path.join(root, "file"), "child"), { code: "not_a_directory", status: 400 });
    assert.deepEqual(await readdir(root), ["file"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a parent without write permission returns a recoverable refusal", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    await chmod(root, 0o555);
    await assert.rejects(createChildDirectory(root, "child"), { code: "access_denied", status: 403 });
    assert.deepEqual(await readdir(root), []);
    await chmod(root, 0o700);
    await createChildDirectory(root, "child");
    assert.deepEqual(await readdir(root), ["child"]);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows rejects device names and names Win32 cannot represent", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    for (const name of ["CON", "nul.txt", "COM1", "LPT9.log", "trailing.", "a:b", "a?b", "a*b", 'a"b', "a|b", "<name>"]) {
      await assert.rejects(createChildDirectory(root, name), { code: "invalid_directory_name", status: 400 });
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
