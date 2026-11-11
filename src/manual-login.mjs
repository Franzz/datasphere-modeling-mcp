import { spawn } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { cliEntry } from './cli.mjs';

const aliases = {
  '--options-file': '-O', '--host': '-H', '--client-id': '-c',
  '--authorization-url': '-a',
};

function argument(args, name) {
  for (let index = args.length - 1; index >= 0; index--) {
    for (const flag of [name, aliases[name]].filter(Boolean)) {
      if (args[index].startsWith(`${flag}=`)) return args[index].slice(flag.length + 1);
      if (args[index] === flag) {
        if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error(`${flag} needs a value`);
        return args[index + 1];
      }
    }
  }
}

export function authorizationRequest(host, options, state) {
  if ((options['authorization-flow'] || 'authorization_code') !== 'authorization_code') {
    throw new Error('--manual is for authorization_code login; omit it for a Technical User client.');
  }
  const clientId = options['client-id'];
  if (typeof clientId !== 'string' || !clientId || clientId.includes('YOUR-')) {
    throw new Error('Set client-id in the OAuth options file before signing in.');
  }
  let endpoint = options['authorization-url'];
  if (!endpoint) {
    const match = new URL(host).hostname.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.hcs\.cloud\.sap$/i);
    if (!match || !clientId.startsWith('sb-')) {
      throw new Error('Set authorization-url from Datasphere App Integration for this tenant/client.');
    }
    endpoint = `https://${match[1]}.authentication.${match[2]}.hana.ondemand.com/oauth/authorize`;
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('authorization-url must be HTTPS without credentials or a fragment.');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', state);
  return url.toString();
}

export function callbackCode(value, state) {
  let url;
  try { url = new URL(value.trim()); } catch {
    throw new Error('Paste the complete http://localhost:8080/ callback URL from the browser address bar.');
  }
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.port !== '8080' || url.username || url.password || url.pathname !== '/') {
    throw new Error('Expected the registered callback URL http://localhost:8080/.');
  }
  if (url.searchParams.get('state') !== state) {
    throw new Error('The callback does not match this login. Open the link printed by this command and sign in again.');
  }
  if (url.searchParams.has('error')) throw new Error('The identity provider rejected sign-in. Check the OAuth client and registered redirect URI.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The callback contains no authorization code.');
  return code;
}

async function readCallback() {
  // Hide the callback/code while typing; it must not enter terminal history or logs.
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const readline = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) });
  try {
    process.stdout.write('Paste the full callback URL here (input hidden), then press Enter: ');
    return await readline.question('');
  } finally {
    readline.close();
    silent.end();
    process.stdout.write('\n');
  }
}

export function runInteractiveCli(args, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: config.root, stdio: 'inherit',
      env: { ...process.env, LOG_LEVEL: '1', LOGGERS: '' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

export async function manualLogin(args, config, {
  prompt = readCallback, run = runInteractiveCli, output = (message) => process.stdout.write(message),
  mode = 'manual',
} = {}) {
  const optionsPath = argument(args, '--options-file');
  if (!optionsPath) throw new Error('Manual login requires --options-file oauth-options.json.');
  const options = JSON.parse(await readFile(path.resolve(config.root, optionsPath), 'utf8'));
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('The OAuth options file must contain a JSON object.');
  if (typeof options['client-secret'] !== 'string' || !options['client-secret'] || options['client-secret'].includes('YOUR-')) {
    throw new Error('Set client-secret in the OAuth options file before signing in.');
  }
  if (args.some((arg) => /^--(?:secrets-file|code)(?:=|$)/.test(arg)) || args.includes('-s')) {
    throw new Error('Manual login uses the OAuth options file; omit --secrets-file and --code.');
  }
  for (const name of ['--client-id', '--authorization-url', '--authorization-flow']) {
    const value = argument(args, name);
    if (value !== undefined) options[name.slice(2)] = value;
  }
  const host = argument(args, '--host') || config.host || options.host;
  if (!host) throw new Error('Configure the Datasphere tenant host before signing in.');
  const state = randomBytes(32).toString('hex');
  const url = authorizationRequest(host, options, state);
  if (mode === 'browser') {
    output('Opening Windows Firefox. Complete sign-in in the browser; waiting up to five minutes.\n');
  } else {
    output(`Open this link in a browser on your computer:\n\n${url}\n\n`);
    output('After signing in, the browser may report that localhost cannot be reached.\nCopy the complete URL from its address bar, including code and state.\nThe OAuth client redirect URI must be http://localhost:8080/.\n');
  }
  const code = callbackCode(await prompt({ url, state }), state);
  // Pass the one-time code through a private options file, never a command-line argument.
  const directory = await mkdtemp(path.join(tmpdir(), 'datasphere-login-'));
  try {
    const file = path.join(directory, 'oauth-options.json');
    await writeFile(file, JSON.stringify({ ...options, code }), { mode: 0o600 });
    const forwarded = args.filter((value) => value !== '--manual');
    for (let index = 0; index < forwarded.length; index++) {
      if (forwarded[index] === '--options-file' || forwarded[index] === '-O') {
        forwarded[index + 1] = file;
        index++;
      } else if (/^(--options-file|-O)=/.test(forwarded[index])) {
        forwarded[index] = `--options-file=${file}`;
      }
    }
    return await run(forwarded, config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
