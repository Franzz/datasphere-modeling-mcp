import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { DatasphereCli, executeCli, parseOutput, redact } from '../src/cli.mjs';

const config = { root: process.cwd(), host: 'https://example.invalid', timeoutMs: 5000 };
const option = (args, name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

test('uses private files and shell-free arguments, parses output file, and cleans up', async () => {
  let directory;
  const definition = { definitions: { 'A;$(touch SHOULD_NOT_EXIST)': { kind: 'entity' } } };
  const cli = new DatasphereCli({ ...config, secretsFile: '/tmp/secret file.json' }, async (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.equal(options.shell, undefined);
    assert.equal(options.env.LOG_LEVEL, '1');
    assert.ok(args.includes('--space=SALES;$(echo unsafe)'));
    assert.ok(args.includes('--secrets-file=/tmp/secret file.json'));
    const input = option(args, '--file-path');
    directory = input.slice(0, input.lastIndexOf('/'));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(input)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), definition);
    await writeFile(option(args, '--output'), '{"status":"NotDeployed"}');
    return { stdout: 'Some CLI progress text\n' };
  });
  assert.deepEqual(await cli.run(['objects', 'views', 'create', '--space=SALES;$(echo unsafe)'], { definition }), { status: 'NotDeployed' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('failure is redacted, cleaned up, not retried, and does not poison subsequent calls', async () => {
  let calls = 0;
  let output;
  const cli = new DatasphereCli(config, async (_, args) => {
    output = option(args, '--output');
    calls++;
    if (calls === 1) {
      throw Object.assign(new Error('command with unlabelled secret must not be returned'), {
        stderr: 'access_token=abc123 password="supersecret" Bearer opaque.token', killed: true,
      });
    }
    return { stdout: '{"ok":true}' };
  });
  await assert.rejects(cli.run(['objects', 'views', 'update']), (error) => {
    assert.doesNotMatch(error.message, /abc123|supersecret|opaque.token|unlabelled secret/);
    assert.match(error.message, /may have reached the tenant/);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual(await cli.run(['spaces', 'list']), { ok: true });
});

test('serializes concurrent CLI calls', async () => {
  let active = 0;
  let maxActive = 0;
  const cli = new DatasphereCli(config, async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { stdout: '{}' };
  });
  await Promise.all([cli.run(['spaces', 'list']), cli.run(['spaces', 'list'])]);
  assert.equal(maxActive, 1);
});

test('an unanswered SAP prompt is an error even when the CLI exits zero', async () => {
  let output;
  const cli = new DatasphereCli(config, async (_, args) => {
    output = option(args, '--output');
    return { stdout: '\x1b[2K\x1b[1G\x1b[36m?\x1b[39m Provide a value for option objectname: \x1b7\x1b8' };
  });
  await assert.rejects(cli.run(['tasks', 'logs', 'list']), /requested interactive input instead of completing/);
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('does not spawn without a host or for a cancelled queued request', async () => {
  const execute = () => assert.fail('must not spawn');
  await assert.rejects(new DatasphereCli({ ...config, host: undefined }, execute).run(['spaces', 'list']), /DATASPHERE_HOST/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(new DatasphereCli(config, execute).run(['spaces', 'list'], { signal: abort.signal }), /cancelled/);
});

test('real subprocess receives EOF and an abort terminates a running child', async () => {
  const result = await executeCli(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log("EOF"));'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.stdout.trim(), 'EOF');
  const abort = new AbortController();
  const child = executeCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal });
  abort.abort();
  await assert.rejects(child, { name: 'AbortError' });
});

test('parses primitive or text responses and redacts nested credential fields', () => {
  assert.equal(parseOutput('42'), 42);
  assert.deepEqual(parseOutput('Saved'), { message: 'Saved' });
  assert.deepEqual(redact({ rows: [{ client_secret: 'x', value: 1 }], refreshToken: 'y' }), { rows: [{ client_secret: '[REDACTED]', value: 1 }], refreshToken: '[REDACTED]' });
});
