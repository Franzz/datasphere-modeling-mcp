import test from 'node:test';
import assert from 'node:assert/strict';
import { findWindowsFirefox, waitForBrowserCallback } from '../src/browser-login.mjs';

test('Windows Firefox lookup handles per-user installations and rejects invalid registrations', async () => {
  const executable = await findWindowsFirefox(async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.at(-1).includes('HKCU:'));
    return { stdout: 'C:\\Users\\Synthetic User\\AppData\\Local\\Mozilla Firefox\\firefox.exe\r\n' };
  });
  assert.equal(executable, '/mnt/c/Users/Synthetic User/AppData/Local/Mozilla Firefox/firefox.exe');
  await assert.rejects(findWindowsFirefox(async () => ({ stdout: 'not-an-executable' })), /supported executable/);
});

test('browser callback listener starts before launch and validates a real HTTP callback', async () => {
  const request = { url: 'https://identity.invalid/oauth/authorize?state=expected', state: 'expected' };
  const result = await waitForBrowserCallback(request, '/synthetic/firefox.exe', {
    port: 0,
    async launch(executable, url, port) {
      assert.equal(executable, '/synthetic/firefox.exe');
      assert.equal(url, request.url);
      const unrelated = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
      assert.equal(unrelated.status, 404);
      const response = await fetch(`http://127.0.0.1:${port}/?code=synthetic&state=expected`);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /code=synthetic/);
    },
  });
  assert.equal(result, 'http://localhost:8080/?code=synthetic&state=expected');
});

test('browser callback rejects wrong state and returns bounded errors for timeout and launch failure', async () => {
  const request = { url: 'https://identity.invalid/', state: 'expected' };
  await assert.rejects(waitForBrowserCallback(request, '/synthetic/firefox.exe', {
    port: 0,
    async launch(_, __, port) {
      const response = await fetch(`http://127.0.0.1:${port}/?code=synthetic&state=wrong`);
      assert.equal(response.status, 400);
      await response.text();
    },
  }), /does not match/);
  await assert.rejects(waitForBrowserCallback(request, '/synthetic/firefox.exe', {
    port: 0, timeoutMs: 20, async launch() {},
  }), /timed out/);
  await assert.rejects(waitForBrowserCallback(request, '/synthetic/firefox.exe', {
    port: 0, async launch() { throw new Error('Synthetic launch failure'); },
  }), /Synthetic launch failure/);
});
