import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopeNames = new Set(['read', 'write', 'execute', 'delete']);

export function loadConfig(env = process.env, root = projectDir) {
  const configFile = path.resolve(root, env.DATASPHERE_CONFIG_FILE || 'datasphere.config.json');
  let local = {};
  if (fs.existsSync(configFile)) {
    try {
      local = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error();
    } catch {
      throw new Error(`Expected a JSON object in ${configFile}`);
    }
  }
  const hostValue = env.DATASPHERE_HOST || local.host;
  let host;
  if (hostValue) {
    const url = new URL(hostValue);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('DATASPHERE_HOST must be an HTTPS tenant URL without credentials');
    }
    host = url.origin;
  }
  const scopeValue = env.DATASPHERE_STDIO_SCOPES ?? local.scopes ?? 'read,write';
  if (typeof scopeValue !== 'string') throw new Error('Scopes must be a comma-separated string');
  const scopes = new Set(scopeValue.split(/[\s,]+/).filter(Boolean));
  for (const scope of scopes) {
    if (!scopeNames.has(scope)) throw new Error(`Unknown Datasphere scope: ${scope}`);
  }
  scopes.add('read');
  const timeoutMs = Number(env.DATASPHERE_TIMEOUT_MS ?? local.timeoutMs ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    throw new Error('DATASPHERE_TIMEOUT_MS must be an integer from 1000 to 900000');
  }
  const secretsFile = env.DATASPHERE_SECRETS_FILE || local.secretsFile;
  if (secretsFile && typeof secretsFile !== 'string') throw new Error('secretsFile must be a path');
  const space = env.DATASPHERE_SPACE || local.space;
  if (space && (typeof space !== 'string' || /^-|[\x00-\x1f]/.test(space))) {
    throw new Error('DATASPHERE_SPACE must be a valid space ID');
  }
  return {
    root,
    host,
    space,
    scopes,
    timeoutMs,
    // Local config paths are relative to that config file; env paths are relative to this repo.
    secretsFile: secretsFile ? path.resolve(
      env.DATASPHERE_SECRETS_FILE ? root : path.dirname(configFile), secretsFile,
    ) : undefined,
  };
}
