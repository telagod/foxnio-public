import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJiti } from 'jiti';
import { spawnSync } from 'node:child_process';
const jiti = createJiti(import.meta.url, { tryNative: false });
const { StorageEngine } = await jiti.import('./engine.ts');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fox-data-'));
  const roots = { agentDir: join(root, 'agent'), sessionsDir: join(root, 'sessions'), foxDir: join(root, 'fox') };
  mkdirSync(roots.agentDir); mkdirSync(roots.foxDir);
  const engines = [];
  const open = () => { const e = new StorageEngine(roots); engines.push(e); return e; };
  t.after(async () => { for (const e of engines) await e.close(); rmSync(root, { recursive: true, force: true }); });
  return { roots, open, db: join(roots.agentDir, 'omp-web', 'app.db') };
}
const project = { path: '/projects/one', addedAt: '2026-01-01T00:00:00.000Z', hidden: false };
const session = (i) => ({ path: `/sessions/${i}.jsonl`, id: `session-${i}`, cwd: '/projects/one', created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z', messageCount: 1, firstMessage: 'hello' });

test('malformed required legacy source never partially imports or retires original files', async t => {
  const f = fixture(t); writeFileSync(join(f.roots.agentDir, 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
  writeFileSync(join(f.roots.foxDir, 'session.json'), '{broken');
  const e = f.open();
  assert.equal((await e.request({ operation: 'status' })).error.code, 'migration_required');
  await assert.rejects(e.request({ operation: 'migrate', offline: true }), { code: 'migration_failed' });
  assert.equal(readFileSync(join(f.roots.foxDir, 'session.json'), 'utf8'), '{broken');
  writeFileSync(join(f.roots.foxDir, 'session.json'), JSON.stringify({ sessionId: 'session-one', resetAt: null, revokedSessionId: null }));
  await e.request({ operation: 'migrate', offline: true });
  assert.deepEqual((await e.request({ operation: 'projects.get' })).projects, [project]);
  assert.equal((await e.request({ operation: 'migrate', offline: true })).alreadyMigrated, true);
});

test('missing database refuses fresh initialization even after receipt is also lost', async t => {
  const f = fixture(t); const e = f.open(); await e.request({ operation: 'head' }); await e.close();
  rmSync(f.db); rmSync(`${f.db}.migration-receipt.json`);
  await assert.rejects(f.open().request({ operation: 'head' }), { code: 'restore_required' });
});

test('two connections patch disjoint project fields and pointer CAS cannot resurrect reset identity', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  await a.request({ operation: 'projects.patch', updates: [{ ...project, register: true }] });
  await a.request({ operation: 'projects.patch', updates: [{ path: project.path, alias: 'Alias' }] });
  await b.request({ operation: 'projects.patch', updates: [{ path: project.path, pinOrder: 2 }] });
  assert.deepEqual((await a.request({ operation: 'projects.get' })).projects[0], { ...project, alias: 'Alias', pinOrder: 2 });
  const before = await a.request({ operation: 'foxPointer.get' });
  await b.request({ operation: 'foxPointer.reset' });
  assert.equal(await a.request({ operation: 'foxPointer.cas', expected: before, next: { ...before, sessionId: 'session-old' } }), null);
});

test('notification migration reads committed WAL history without copying retired VAPID', async t => {
  const f = fixture(t); mkdirSync(join(f.roots.agentDir, 'omp-web'));
  const legacy = new DatabaseSync(join(f.roots.agentDir, 'omp-web', 'notifications.db'));
  t.after(() => legacy.close());
  legacy.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE history(id TEXT,event TEXT,at INTEGER,read INTEGER); CREATE TABLE vapid(private_key TEXT);');
  legacy.prepare('INSERT INTO vapid VALUES (?)').run('secret-retired-key');
  const event = { type: 'input', sessionId: 'session-one', sessionName: null };
  legacy.prepare('INSERT INTO history VALUES (?,?,?,?)').run('session-one:input', JSON.stringify(event), 123, 0);
  const e = f.open(); await e.request({ operation: 'migrate', offline: true });
  assert.deepEqual(await e.request({ operation: 'notifications.list' }), [{ id: 'session-one:input', event, at: 123, read: false }]);
  const copy = await e.request({ operation: 'backup' });
  assert.equal(statSync(copy.path).mode & 0o777, 0o600);
  const backup = new DatabaseSync(copy.path, { readOnly: true });
  assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='vapid'").get(), undefined); backup.close();
  assert.equal(existsSync(join(f.roots.agentDir, 'omp-web', 'notifications.db')), true);
});

test('snapshot pages stay on pinned revision while writes commit and pool is bounded', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  await a.request({ operation: 'index.apply', updates: Array.from({ length: 501 }, (_, i) => ({ path: `/sessions/${i}.jsonl`, stamp: '1', session: session(i) })), health: { complete: true, staleSources: [], warnings: [] } });
  const snapshot = await a.request({ operation: 'snapshot.open' });
  assert.equal(snapshot.data.sessions.length, 500); assert.equal(snapshot.next, true);
  await b.request({ operation: 'index.apply', updates: [{ path: '/sessions/99.jsonl', stamp: '2', session: { ...session(99), name: 'new' } }] });
  const page = await a.request({ operation: 'snapshot.page', token: snapshot.token });
  assert.deepEqual(page.cursor, snapshot.cursor); assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0].name, undefined);
  const held = []; for (let i = 0; i < 4; i++) held.push(await a.request({ operation: 'snapshot.open' }));
  await assert.rejects(a.request({ operation: 'snapshot.open' }), { code: 'storage_busy' });
  for (const s of held) await a.request({ operation: 'snapshot.close', token: s.token });
});

test('rebuild invalidates old cursors/read tokens but preserves every application domain', async t => {
  const f = fixture(t), e = f.open();
  await e.request({ operation: 'projects.patch', updates: [{ ...project, register: true }] });
  await e.request({ operation: 'pins.patch', pin: ['session-one'], now: 42 });
  const event = { type: 'input', sessionId: 'session-one', sessionName: null };
  await e.request({ operation: 'notifications.record', event, at: 5 });
  const pointer = await e.request({ operation: 'foxPointer.get' });
  const savedPointer = await e.request({ operation: 'foxPointer.cas', expected: pointer, next: { ...pointer, sessionId: 'session-one' } });
  const observation = await e.request({ operation: 'foxObservation.get' });
  const savedObservation = await e.request({ operation: 'foxObservation.save', expectedVersion: observation.version, state: { ...observation.state, daily: { date: '2026-01-01', count: 3 } } });
  await e.request({ operation: 'index.apply', updates: Array.from({ length: 501 }, (_, i) => ({ path: `/sessions/${i}.jsonl`, stamp: 'one', session: session(i) })) });
  const snapshot = await e.request({ operation: 'snapshot.open' });
  const old = await e.request({ operation: 'head' });
  await e.request({ operation: 'index.rebuild' });
  await assert.rejects(e.request({ operation: 'changes', cursor: old }), { code: 'reset_required' });
  await assert.rejects(e.request({ operation: 'snapshot.page', token: snapshot.token }), { code: 'reset_required' });
  assert.equal((await e.request({ operation: 'projects.get' })).projects.length, 1);
  assert.deepEqual(await e.request({ operation: 'pins.get' }), { pinned: [{ id: 'session-one', at: 42 }] });
  assert.deepEqual(await e.request({ operation: 'foxPointer.get' }), savedPointer);
  assert.deepEqual(await e.request({ operation: 'foxObservation.get' }), savedObservation);
  assert.equal((await e.request({ operation: 'notifications.list' }))[0].id, 'session-one:input');
  assert.equal((await e.request({ operation: 'index.get' })).sessions.length, 0);
});

test('changes bound revisions and reject pruned/future/wrong-generation cursors', async t => {
  const f = fixture(t), e = f.open(), old = await e.request({ operation: 'head' });
  for (let i = 0; i < 10001; i++) await e.request({ operation: 'invalidate', topic: 'operator-settings', keys: [String(i)] });
  await assert.rejects(e.request({ operation: 'changes', cursor: old }), { code: 'reset_required' });
  const head = await e.request({ operation: 'head' });
  const page = await e.request({ operation: 'changes', cursor: { ...head, revision: head.revision - 300 }, limit: 9999 });
  assert.equal(page.changes.length, 256); assert.equal(page.hasMore, true); assert.deepEqual(page.through, head);
  await assert.rejects(e.request({ operation: 'changes', cursor: { ...head, revision: head.revision + 1 } }), { code: 'reset_required' });
});

test('observation outstanding claim survives expiry and rejects overwrite/replay', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const initial = await a.request({ operation: 'foxObservation.get' });
  assert.equal((await a.request({ operation: 'observation.claim', expectedVersion: initial.version, wakeId: 'wake-1', owner: 'a', eventKeys: ['event'], now: 1, leaseMs: 1 })).claimed, true);
  const current = await b.request({ operation: 'foxObservation.get' });
  assert.equal((await b.request({ operation: 'observation.claim', expectedVersion: current.version, wakeId: 'wake-2', owner: 'b', eventKeys: ['event'], now: 10000, leaseMs: 1 })).claimed, false);
  await assert.rejects(b.request({ operation: 'foxObservation.save', expectedVersion: current.version, state: current.state }), { code: 'storage_conflict' });
  await a.request({ operation: 'observation.settle', wakeId: 'wake-1', owner: 'a', outcome: 'uncertain' });
  assert.equal((await b.request({ operation: 'foxObservation.get' })).claim.status, 'uncertain');
});

test('invalid launch configuration and missing reset epoch abort the entire migration', async t => {
  const f = fixture(t), e = f.open();
  writeFileSync(join(f.roots.agentDir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ ...project, launchConfig: { extraArgs: ['--resume', 'other-session'] } }] }));
  await assert.rejects(e.request({ operation: 'migrate', offline: true }), { code: 'migration_failed' });
  assert.equal(existsSync(f.db), false);
  writeFileSync(join(f.roots.agentDir, 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
  writeFileSync(join(f.roots.foxDir, 'session.json'), '{}');
  await assert.rejects(e.request({ operation: 'migrate', offline: true }), { code: 'migration_failed' });
  assert.equal(existsSync(f.db), false);
});

test('stale projection CAS rolls back all rows and repeats do not revise', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  await a.request({ operation: 'index.apply', updates: [{ path: '/sessions/1.jsonl', stamp: 'old', session: session(1) }] });
  await b.request({ operation: 'index.apply', updates: [{ path: '/sessions/1.jsonl', stamp: 'new', session: { ...session(1), name: 'new' } }] });
  const head = await a.request({ operation: 'head' });
  await assert.rejects(a.request({ operation: 'index.apply', updates: [{ path: '/sessions/2.jsonl', stamp: 'one', session: session(2) }, { path: '/sessions/1.jsonl', stamp: 'stale', error: 'stale failure' }], expectedSources: { '/sessions/1.jsonl': 'old', '/sessions/2.jsonl': null } }), { code: 'storage_conflict' });
  assert.deepEqual(await a.request({ operation: 'head' }), head);
  assert.equal((await a.request({ operation: 'index.get' })).sessions.length, 1);
  await a.request({ operation: 'index.apply', updates: [{ path: '/sessions/1.jsonl', stamp: 'new', session: { ...session(1), name: 'new' } }] });
  assert.deepEqual(await a.request({ operation: 'head' }), head);
});

test('expired snapshot tokens require restarting without exposing mixed pages', async t => {
  const f = fixture(t), e = f.open();
  await e.request({ operation: 'index.apply', updates: Array.from({ length: 501 }, (_, i) => ({ path: `/sessions/${i}.jsonl`, stamp: '1', session: session(i) })) });
  const snapshot = await e.request({ operation: 'snapshot.open' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(30001);
  await assert.rejects(e.request({ operation: 'snapshot.page', token: snapshot.token }), { code: 'reset_required' });
});

test('identical cross-process source commits are noops, but stale health-only inventory is rejected', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const update = { path: '/sessions/1.jsonl', stamp: 'new', session: session(1) };
  await a.request({ operation: 'index.apply', updates: [update], expectedSources: { '/sessions/1.jsonl': null } });
  const head = await a.request({ operation: 'head' });
  await b.request({ operation: 'index.apply', updates: [update], expectedSources: { '/sessions/1.jsonl': null } });
  assert.deepEqual(await b.request({ operation: 'head' }), head);
  await assert.rejects(b.request({ operation: 'index.apply', updates: [], expectedSources: { '/sessions/1.jsonl': 'old' }, health: { complete: true, staleSources: [], warnings: [] } }), { code: 'storage_conflict' });
  assert.deepEqual(await b.request({ operation: 'head' }), head);
});

test('observation corruption fails closed unless explicitly discarded and documented', async t => {
  const f = fixture(t), e = f.open();
  writeFileSync(join(f.roots.foxDir, 'service-state.json'), JSON.stringify({ version: 99, daily: { count: 7 } }));
  await assert.rejects(e.request({ operation: 'migrate', offline: true }), { code: 'migration_failed' });
  assert.equal(existsSync(f.db), false);
  const result = await e.request({ operation: 'migrate', offline: true, discardObservation: true });
  assert.equal(result.warnings.length, 1);
  assert.equal((await e.request({ operation: 'foxObservation.get' })).state.daily.count, 0);
});

test('notification recording settles input atomically and unchanged commands do not revise', async t => {
  const f = fixture(t), e = f.open();
  const input = { type: 'input', sessionId: 'session-one', sessionName: null };
  await e.request({ operation: 'notifications.record', event: input, at: 1 });
  const before = await e.request({ operation: 'head' });
  await e.request({ operation: 'notifications.record', event: { ...input, type: 'completed' }, at: 2, settleInputIds: ['session-one:input'] });
  const after = await e.request({ operation: 'head' });
  assert.equal(after.revision, before.revision + 1);
  const rows = await e.request({ operation: 'notifications.list' });
  assert.equal(rows.find(row => row.id === 'session-one:input').read, true);
  await e.request({ operation: 'notifications.read', ids: ['session-one:input'] });
  assert.deepEqual(await e.request({ operation: 'head' }), after);
});

test('a replacement worker recovers only a proven abandoned maintenance owner', async t => {
  const f = fixture(t), e = f.open(); await e.request({ operation: 'head' }); await e.close();
  writeFileSync(`${f.db}.maintenance`, JSON.stringify({ pid: process.pid, owner: 'terminated-worker' }));
  await assert.rejects(f.open().request({ operation: 'head' }), { code: 'storage_busy' });
  const replacement = new StorageEngine(f.roots, { owner: 'replacement-worker', abandonedOwners: ['terminated-worker'] });
  try { assert.equal((await replacement.request({ operation: 'status' })).ready, true); }
  finally { await replacement.close(); }
});

test('observation claim keeps the original target identity after reopen', async t => {
  const f = fixture(t), e = f.open();
  const initial = await e.request({ operation: 'foxObservation.get' });
  await e.request({ operation: 'observation.claim', expectedVersion: initial.version, wakeId: 'wake-target', owner: 'observer', targetSessionId: 'session-original', eventKeys: ['event'], now: 1, leaseMs: 100 });
  await e.close();
  const reopened = f.open(), current = await reopened.request({ operation: 'foxObservation.get' });
  assert.equal(current.claim.targetSessionId, 'session-original');
  await reopened.request({ operation: 'observation.settle', wakeId: 'wake-target', owner: 'observer', outcome: 'uncertain' });
  assert.equal((await reopened.request({ operation: 'foxObservation.get' })).claim.targetSessionId, 'session-original');
});

test('initialization process crashes before commit or publication leave the legacy authority recoverable', async t => {
  for (const phase of ['before-commit', 'before-publish', 'after-publish']) {
    const f = fixture(t);
    writeFileSync(join(f.roots.agentDir, 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { DatabaseSync } from 'node:sqlite';
      import { createJiti } from 'jiti';
      const phase = ${JSON.stringify(phase)};
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (phase === 'before-commit' && sql === 'COMMIT') process.exit(91);
        return exec.call(this, sql);
      };
      const link = fs.linkSync;
      fs.linkSync = (...args) => {
        if (phase === 'before-publish') process.exit(92);
        const result = link(...args);
        if (phase === 'after-publish') process.exit(93);
        return result;
      };
      syncBuiltinESMExports();
      const {StorageEngine} = await createJiti(${JSON.stringify(import.meta.url)}, {tryNative:false}).import(${JSON.stringify(new URL('./engine.ts', import.meta.url).href)});
      await new StorageEngine(${JSON.stringify(f.roots)}).request({operation:'migrate',offline:true});
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(child.status, { 'before-commit': 91, 'before-publish': 92, 'after-publish': 93 }[phase], child.stderr);
    assert.equal(readFileSync(join(f.roots.agentDir, 'projects.json'), 'utf8'), JSON.stringify({ version: 1, projects: [project] }));
    if (phase !== 'after-publish') assert.equal(existsSync(f.db), false);
    if (phase === 'after-publish') assert.equal((await f.open().request({ operation: 'status' })).ready, true);
    const engine = f.open();
    await engine.request({ operation: 'migrate', offline: true });
    assert.deepEqual((await engine.request({ operation: 'projects.get' })).projects, [project]);
    assert.equal(readdirSync(join(f.roots.agentDir, 'omp-web')).some(name => name.startsWith('app.db.init-')), false);
  }
});

test('damaged or missing retained migration backups warn without blocking committed app data', async t => {
  const f = fixture(t), legacy = join(f.roots.agentDir, 'projects.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, projects: [project] }));
  const first = f.open(); await first.request({ operation: 'migrate', offline: true });
  await first.request({ operation: 'projects.patch', updates: [{ path: project.path, alias: 'new-authority' }] });
  await first.close();
  const directory = join(f.roots.agentDir, 'omp-web');
  const retained = join(directory, readdirSync(directory).find(name => name.startsWith('app.db.migration-backup-projects.json-')));
  writeFileSync(retained, 'damaged'); rmSync(legacy);
  const reopened = f.open();
  assert.equal((await reopened.request({ operation: 'status' })).ready, true);
  assert.equal((await reopened.request({ operation: 'projects.get' })).projects[0].alias, 'new-authority');
  assert.ok((await reopened.request({ operation: 'snapshot.open' })).warnings.some(warning => warning.includes('backup')));
  await reopened.close(); rmSync(retained);
  const missing = f.open();
  assert.equal((await missing.request({ operation: 'status' })).ready, true);
  assert.equal((await missing.request({ operation: 'projects.get' })).projects[0].alias, 'new-authority');
  assert.ok((await missing.request({ operation: 'snapshot.open' })).warnings.some(warning => warning.includes('backup')));
});

test('unrecognized final databases and staging artifacts are never removed as initialization debris', async t => {
  const final = fixture(t); mkdirSync(join(final.roots.agentDir, 'omp-web'));
  writeFileSync(final.db, 'not a database');
  await assert.rejects(final.open().request({ operation: 'migrate', offline: true }));
  assert.equal(readFileSync(final.db, 'utf8'), 'not a database');
  const stage = fixture(t), directory = join(stage.roots.agentDir, 'omp-web', 'app.db.init-00000000-0000-0000-0000-000000000000');
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'app.db'), 'unowned user data');
  await assert.rejects(stage.open().request({ operation: 'migrate', offline: true }), { code: 'restore_required' });
  assert.equal(readFileSync(join(directory, 'app.db'), 'utf8'), 'unowned user data');
});

test('receipt installation mismatch still blocks a healthy database', async t => {
  const f = fixture(t), engine = f.open(); await engine.request({ operation: 'head' }); await engine.close();
  const path = `${f.db}.migration-receipt.json`, receipt = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...receipt, installationId: 'another-installation' }));
  await assert.rejects(f.open().request({ operation: 'head' }), { code: 'restore_required' });
});
