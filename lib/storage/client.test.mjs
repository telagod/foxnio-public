import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tryNative: false });
const { StorageWorkerClient, storageRequest, storageRoots, subscribeStorageChanges, closeStorage } = await jiti.import('./client.ts');
function setup(t, factory) {
  const root = mkdtempSync(join(tmpdir(), 'fox-storage-client-'));
  const roots = { agentDir: join(root, 'agent'), sessionsDir: join(root, 'sessions'), foxDir: join(root, 'fox') };
  mkdirSync(roots.agentDir);
  const client = new StorageWorkerClient(roots, () => factory?.() ?? new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { roots }, execArgv: [] }));
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }); });
  return { client, roots };
}
test('queue allows one active plus 64 waiting and overload has definite noncommit outcome', async t => {
  const { client } = setup(t);
  const requests = Array.from({ length: 65 }, () => client.request({ operation: 'pins.patch', pin: ['session-one'] }));
  await assert.rejects(client.request({ operation: 'pins.patch', pin: ['session-two'] }), { code: 'storage_busy', outcome: 'not_committed' });
  await Promise.all(requests);
  assert.deepEqual((await client.request({ operation: 'pins.get' })).pinned.map(p => p.id), ['session-one']);
});
test('worker loss rejects admitted mutation as uncertain, queued mutation as noncommitted, and next query restarts', async t => {
  let roots, started = false;
  const f = setup(t, () => {
    if (started) return new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { roots }, execArgv: [] });
    started = true;
    // Exercise the real engine, but crash after COMMIT and before the IPC reply.
    return new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { createJiti } = require('jiti');
      (async () => {
        const { StorageEngine } = await createJiti(workerData.module, { tryNative: false }).import(workerData.module);
        const engine = new StorageEngine(workerData.roots);
        parentPort.on('message', async ({ id, request }) => {
          const value = await engine.request(request);
          if (request.operation === 'pins.patch') process.exit(3);
          parentPort.postMessage({ id, value });
        });
      })();
    `, { eval: true, workerData: { roots, module: new URL('./engine.ts', import.meta.url).href }, execArgv: [] });
  });
  roots = f.roots;
  await f.client.request({ operation: 'head' });
  const active = f.client.request({ operation: 'pins.patch', pin: ['session-one'] });
  const queued = f.client.request({ operation: 'pins.patch', pin: ['session-two'] });
  const activeRejected = assert.rejects(active, { code: 'storage_unavailable', outcome: 'uncertain' });
  const queuedRejected = assert.rejects(queued, { code: 'storage_unavailable', outcome: 'not_committed' });
  await Promise.all([activeRejected, queuedRejected]);
  const pins = await f.client.request({ operation: 'pins.get' });
  assert.equal(pins.pinned.some(p => p.id === 'session-two'), false);
  assert.equal(pins.pinned.some(p => p.id === 'session-one'), true);
});

test('subscribers reconcile another process commit and an authoritative revision rollback', async t => {
  const home = mkdtempSync(join(tmpdir(), 'fox-storage-head-'));
  const keys = ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'XDG_DATA_HOME', 'OMP_WEB_PACKAGE_DIR'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = join(home, '.omp', 'agent');
  delete process.env.PI_CONFIG_DIR; delete process.env.XDG_DATA_HOME;
  process.env.OMP_WEB_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
  t.after(async () => { await closeStorage(); for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } rmSync(home, { recursive: true, force: true }); });
  const before = await storageRequest({ operation: 'head' });
  let stop, deadline;
  const changed = new Promise((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Cross-process revision was not observed')), 10000);
    stop = subscribeStorageChanges(cursor => { if (cursor.generation === before.generation && cursor.revision > before.revision) resolve(cursor); });
  });
  try {
    const source = `import {createJiti} from 'jiti'; const {StorageEngine}=await createJiti(${JSON.stringify(import.meta.url)},{tryNative:false}).import(${JSON.stringify(new URL('./engine.ts', import.meta.url).href)}); const e=new StorageEngine(${JSON.stringify(storageRoots())}); await e.request({operation:'pins.patch',pin:['session-child']}); await e.close();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); });
    const cursor = await changed;
    assert.equal(cursor.revision, before.revision + 1);
    assert.equal((await storageRequest({ operation: 'pins.get' })).pinned[0].id, 'session-child');
    clearTimeout(deadline);
    let stopRollback;
    const rollback = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Authoritative lower revision was ignored')), 10000);
      stopRollback = subscribeStorageChanges(head => { if (head.generation === before.generation && head.revision === before.revision) resolve(head); });
    });
    try {
      // Model the authoritative clock after an explicitly approved offline
      // restore, without letting the client perform any restore itself.
      const external = new DatabaseSync(join(storageRoots().agentDir, 'omp-web', 'app.db'));
      try { external.prepare('UPDATE data_clock SET revision=? WHERE id=1').run(before.revision); }
      finally { external.close(); }
      assert.deepEqual(await rollback, before);
    } finally { stopRollback(); }
  } finally { stop(); clearTimeout(deadline); }
});
