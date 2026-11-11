#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Called by the parent build; standalone use prints entries without changing host configuration. */
export async function build({ current = {} } = {}) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(command, [fs.existsSync(path.join(here, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], {
    cwd: here, stdio: 'inherit', shell: process.platform === 'win32',
  });
  execFileSync(command, ['run', 'check'], { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
  const env = { ...current['datasphere-mcp']?.env };
  // Only configuration paths and settings are copied; authentication stays in SAP's CLI cache or secrets file.
  for (const key of ['DATASPHERE_HOST', 'DATASPHERE_SPACE', 'DATASPHERE_CONFIG_FILE', 'DATASPHERE_SECRETS_FILE', 'DATASPHERE_STDIO_SCOPES', 'DATASPHERE_TIMEOUT_MS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  process.stderr.write('[build:datasphere] Ready. Configure datasphere.config.json and sign in with npm run cli -- login --options-file oauth-options.json.\n');
  return { 'datasphere-mcp': { type: 'stdio', command: process.execPath, args: [path.join(here, 'src/stdio.mjs')], env } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify({ mcpServers: await build() }, null, 2)}\n`); }
  catch (error) { process.stderr.write(`[build:datasphere] ${error.message}\n`); process.exitCode = 1; }
}
