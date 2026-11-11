import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

test('local configuration, environment precedence, relative paths, and scope parsing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'datasphere-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'datasphere.config.json'), JSON.stringify({ host: 'https://one.invalid/dwc/index.html', space: 'DEV', scopes: 'read', secretsFile: 'my-secrets.json' }));
  const local = loadConfig({}, root);
  assert.equal(local.host, 'https://one.invalid');
  assert.equal(local.space, 'DEV');
  assert.deepEqual([...local.scopes], ['read']);
  assert.equal(local.secretsFile, path.join(root, 'my-secrets.json'));
  const env = loadConfig({ DATASPHERE_HOST: 'https://two.invalid/', DATASPHERE_STDIO_SCOPES: 'write execute', DATASPHERE_SPACE: 'TEST' }, root);
  assert.equal(env.host, 'https://two.invalid');
  assert.equal(env.space, 'TEST');
  assert.deepEqual([...env.scopes], ['write', 'execute', 'read']);
});

test('rejects invalid configuration before startup', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'datasphere-config-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => loadConfig({ DATASPHERE_HOST: 'http://example.invalid' }, root), /HTTPS/);
  assert.throws(() => loadConfig({ DATASPHERE_STDIO_SCOPES: 'admin' }, root), /Unknown/);
  assert.throws(() => loadConfig({ DATASPHERE_TIMEOUT_MS: 'NaN' }, root), /integer/);
  await writeFile(path.join(root, 'datasphere.config.json'), '[]');
  assert.throws(() => loadConfig({}, root), /JSON object/);
});
