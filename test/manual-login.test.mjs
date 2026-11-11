import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authorizationRequest, callbackCode, manualLogin } from '../src/manual-login.mjs';

test('manual authorization derives standard URLs and supports explicit tenant overrides', () => {
  const options = { 'client-id': 'sb-synthetic!client' };
  const standard = new URL(authorizationRequest('https://tenant.eu10.hcs.cloud.sap', options, 'random-state'));
  assert.equal(standard.origin, 'https://tenant.authentication.eu10.hana.ondemand.com');
  assert.equal(standard.pathname, '/oauth/authorize');
  assert.equal(standard.searchParams.get('client_id'), options['client-id']);
  assert.equal(standard.searchParams.get('state'), 'random-state');
  assert.equal(standard.searchParams.get('response_type'), 'code');
  const custom = new URL(authorizationRequest('https://custom.invalid', { ...options, 'authorization-url': 'https://identity.invalid/oauth/authorize' }, 'state'));
  assert.equal(custom.origin, 'https://identity.invalid');
  assert.throws(() => authorizationRequest('https://custom.invalid', options, 'state'), /Set authorization-url/);
  assert.throws(() => authorizationRequest('https://tenant.eu10.hcs.cloud.sap', { ...options, 'authorization-flow': 'client_credentials' }, 'state'), /Technical User/);
});

test('callback validation rejects mismatched state, failed login, and unexpected callback URLs', () => {
  assert.equal(callbackCode('http://localhost:8080/?code=synthetic&state=expected', 'expected'), 'synthetic');
  assert.throws(() => callbackCode('http://localhost:8080/?code=synthetic&state=wrong', 'expected'), /does not match/);
  assert.throws(() => callbackCode('http://localhost:8080/?error=access_denied&state=expected', 'expected'), /rejected/);
  assert.throws(() => callbackCode('https://attacker.invalid/?code=synthetic&state=expected', 'expected'), /registered callback/);
  assert.throws(() => callbackCode('http://localhost:8080/?state=expected', 'expected'), /no authorization code/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'datasphere-manual-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { 'client-id': 'sb-synthetic-client', 'client-secret': 'synthetic-secret', 'authorization-flow': 'authorization_code' };
  await writeFile(path.join(root, 'oauth-options.json'), JSON.stringify(options));
  return { config: { root, host: 'https://tenant.eu10.hcs.cloud.sap' }, options };
}

test('manual login passes its code in a private temporary file, preserves exit code, and cleans up', async (t) => {
  const { config, options } = await fixture(t);
  let loginLink;
  let temporaryFile;
  let calls = 0;
  const result = await manualLogin(['login', '--manual', '--options-file', 'oauth-options.json', `--host=${config.host}`], config, {
    output(message) {
      assert.ok(!message.includes('synthetic-secret'));
      const link = message.match(/https:\/\/[^\s]+/);
      if (link) loginLink = new URL(link[0]);
    },
    async prompt() { return `http://localhost:8080/?code=one-time-synthetic-code&state=${loginLink.searchParams.get('state')}`; },
    async run(args) {
      calls++;
      assert.ok(!args.includes('--manual'));
      assert.ok(!args.join(' ').includes('one-time-synthetic-code'));
      temporaryFile = args[args.indexOf('--options-file') + 1];
      assert.equal((await stat(temporaryFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(temporaryFile, 'utf8')), { ...options, code: 'one-time-synthetic-code' });
      return 7;
    },
  });
  assert.equal(result, 7);
  assert.equal(calls, 1);
  await assert.rejects(access(temporaryFile), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(path.join(config.root, 'oauth-options.json'), 'utf8')), options);
});

test('failed callback does not start SAP CLI; temporary credentials are also cleaned up if spawning fails', async (t) => {
  const { config } = await fixture(t);
  await assert.rejects(manualLogin(['login', '--manual', '--options-file=oauth-options.json'], config, {
    output() {}, prompt: async () => 'http://localhost:8080/?code=synthetic&state=unrelated',
    run() { assert.fail('Must not start CLI on a state mismatch'); },
  }), /does not match/);
  let state;
  let temporaryFile;
  await assert.rejects(manualLogin(['login', '--manual', '--options-file=oauth-options.json'], config, {
    output(message) { const link = message.match(/https:\/\/[^\s]+/); if (link) state = new URL(link[0]).searchParams.get('state'); },
    prompt: async () => `http://localhost:8080/?code=synthetic&state=${state}`,
    async run(args) {
      temporaryFile = args.find((arg) => arg.startsWith('--options-file=')).slice('--options-file='.length);
      throw new Error('Synthetic spawn failure');
    },
  }), /Synthetic spawn failure/);
  await assert.rejects(access(temporaryFile), { code: 'ENOENT' });
});
