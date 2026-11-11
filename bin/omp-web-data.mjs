#!/usr/bin/env node
import { createJiti } from 'jiti';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.OMP_WEB_PACKAGE_DIR ||= resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: foxnio data status | migrate --offline [--discard-observation] | backup | rebuild-index';
const [command, ...flags] = process.argv.slice(2);
const valid = ['status', 'migrate', 'backup', 'rebuild-index'].includes(command)
  && (command === 'migrate' ? flags.includes('--offline') && flags.every(flag => ['--offline', '--discard-observation'].includes(flag)) : flags.length === 0);
if (!valid) { console.error(usage); process.exitCode = 2; }
else {
  const jiti = createJiti(import.meta.url, { tryNative: false });
  const { storageRequest, closeStorage } = await jiti.import('../lib/storage/client.ts');
  try {
    let result;
    if (command === 'migrate') {
      console.error('--offline asserts that all old foxnio instances have been stopped; PID detection is not proof of offline state.');
      result = await storageRequest({ operation: 'migrate', offline: true, discardObservation: flags.includes('--discard-observation') });
    } else if (command === 'rebuild-index') {
      await storageRequest({ operation: 'index.rebuild' });
      let scanToken;
      do { const batch = await storageRequest({ operation: 'index.scan', force: true, ...(scanToken ? { scanToken } : {}) }); scanToken = batch.nextScanToken; } while (scanToken);
      result = await storageRequest({ operation: 'index.get', ids: [] });
    } else result = await storageRequest({ operation: command });
    console.log(JSON.stringify(result, null, 2));
    if (command === 'status' && !result.ready) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code || 'storage_unavailable', message: error.message || String(error), ...(error.outcome ? { outcome: error.outcome } : {}) } })); process.exitCode = 1;
  } finally { await closeStorage(); }
}
