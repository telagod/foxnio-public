import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { writeFileAtomic } = await jiti.import("./fs-atomic.ts");

const posix = process.platform !== "win32";

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-fs-atomic-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mode = (path) => statSync(path).mode & 0o777;

test("creates a new file owner-only, whatever the umask", { skip: !posix }, () => {
  withDir((dir) => {
    const previous = process.umask(0o000);
    try {
      writeFileAtomic(join(dir, "nested", "config.yml"), "a: 1\n");
    } finally {
      process.umask(previous);
    }
    assert.equal(readFileSync(join(dir, "nested", "config.yml"), "utf8"), "a: 1\n");
    assert.equal(mode(join(dir, "nested", "config.yml")), 0o600);
  });
});

test("keeps the mode of an existing file instead of resetting it", { skip: !posix }, () => {
  withDir((dir) => {
    for (const existing of [0o600, 0o640]) {
      const path = join(dir, `file-${existing.toString(8)}`);
      writeFileSync(path, "old", "utf8");
      chmodSync(path, existing);
      writeFileAtomic(path, "new");
      assert.equal(readFileSync(path, "utf8"), "new");
      assert.equal(mode(path), existing);
    }
  });
});

test("writes through a symlink instead of replacing it", { skip: !posix }, () => {
  withDir((dir) => {
    const target = join(dir, "dotfiles", "config.yml");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(target, "old", "utf8");
    chmodSync(target, 0o640);
    const link = join(dir, "config.yml");
    symlinkSync(target, link);

    writeFileAtomic(link, "new");

    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), target);
    assert.equal(readFileSync(target, "utf8"), "new");
    assert.equal(mode(target), 0o640);
  });
});

test("creates the target of a dangling symlink", { skip: !posix }, () => {
  withDir((dir) => {
    const target = join(dir, "real.yml");
    const link = join(dir, "config.yml");
    symlinkSync("real.yml", link);
    writeFileAtomic(link, "created");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), "created");
  });
});

test("leaves no temp file behind when the write fails", () => {
  withDir((dir) => {
    // A non-empty directory cannot be replaced by a file, so the rename fails
    // after the temp file has been written.
    const blocked = join(dir, "config.yml");
    mkdirSync(join(blocked, "child"), { recursive: true });
    assert.throws(() => writeFileAtomic(blocked, "data"));
    assert.deepEqual(readdirSync(dir), ["config.yml"]);
  });
});

test("backup keeps the previous contents with the previous mode, once per change", { skip: !posix }, () => {
  withDir((dir) => {
    const path = join(dir, "models.yml");
    writeFileSync(path, "first", "utf8");
    chmodSync(path, 0o600);

    writeFileAtomic(path, "second", { backup: true });
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "first");
    assert.equal(mode(`${path}.bak`), 0o600);

    // Saving identical contents must not overwrite the backup with the current file.
    writeFileAtomic(path, "second", { backup: true });
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "first");

    writeFileAtomic(path, "third", { backup: true });
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "second");
  });
});

test("backup of a file that does not exist yet is skipped", () => {
  withDir((dir) => {
    const path = join(dir, "models.yml");
    writeFileAtomic(path, "first", { backup: true });
    assert.deepEqual(readdirSync(dir), ["models.yml"]);
  });
});
