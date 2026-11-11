import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { callbackCode, manualLogin } from './manual-login.mjs';

const execute = promisify(execFile);

/** SAP's open-package lookup assumes a system install; Windows also permits per-user Firefox. */
export async function findWindowsFirefox(run = execute) {
  const script = String.raw`$ErrorActionPreference = 'SilentlyContinue'
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe')) {
  $item = Get-Item -LiteralPath $key
  if ($item) {
    $location = $item.GetValue('')
    if ($location -and (Test-Path -LiteralPath $location)) { [Console]::Out.WriteLine($location); exit 0 }
  }
}
exit 1`;
  let stdout;
  try {
    ({ stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true }));
  } catch {
    throw new Error('Could not locate Windows Firefox. Use login --manual --options-file oauth-options.json.');
  }
  const location = stdout.trim();
  if (!/^[a-z]:\\[^\r\n]+\\firefox\.exe$/i.test(location)) throw new Error('Windows Firefox registration does not contain a supported executable path. Use --manual.');
  return `/mnt/${location[0].toLowerCase()}/${location.slice(3).replaceAll('\\', '/')}`;
}

function launchBrowser(executable, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url], { stdio: 'ignore', detached: true });
    child.once('error', () => reject(new Error('Could not launch Windows Firefox. Use login --manual --options-file oauth-options.json.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Own the loopback callback so a browser sign-in is not limited by SAP's 30-second timer. */
export async function waitForBrowserCallback({ url, state }, executable, {
  port = 8080, timeoutMs = 300000, launch = launchBrowser,
} = {}) {
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // A launch error can occur before we await the callback promise.
  callback.catch(() => {});
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url?.startsWith('/?')) {
      response.writeHead(404).end();
      return;
    }
    const value = `http://localhost:8080${request.url}`;
    try {
      callbackCode(value, state);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Browser authorization received. Return to the terminal to check whether Datasphere login succeeds.');
      resolveCallback(value);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Invalid sign-in callback. Return to the terminal.');
      rejectCallback(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(() => { throw new Error(`Cannot listen on localhost:${port}. Close the other listener or use --manual.`); });
  const timer = setTimeout(() => rejectCallback(new Error('Sign-in timed out after waiting for the browser callback. Retry, or use --manual.')), timeoutMs);
  try {
    await launch(executable, url, server.address().port);
    return await callback;
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

export async function wslFirefoxLogin(args, config) {
  const executable = await findWindowsFirefox();
  await access(executable);
  return manualLogin(args, config, {
    mode: 'browser', prompt: (request) => waitForBrowserCallback(request, executable),
  });
}
