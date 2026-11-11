import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
export function executeCli(file, args, options) {
  const pending = execFileAsync(file, args, options);
  // execFile creates a stdin pipe; close it explicitly so SAP cannot wait for terminal input.
  pending.child.stdin?.end();
  return pending;
}
const require = createRequire(import.meta.url);
export const cliEntry = require.resolve('@sap/datasphere-cli/terminal.js');
const maxBuffer = 16 * 1024 * 1024;
const secretKey = /^(?:client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|password|authorization|passcode)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(entry)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passcode)["']?\s*[:=]\s*["']?)([^\s"',}\]]+)/gi, '$1[REDACTED]');
}

export function parseOutput(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return { message: 'Command completed.' };
  try { return JSON.parse(clean); } catch { return { message: clean }; }
}

/** One process per command isolates SAP's CLI from MCP stdout and interactive input. */
export class DatasphereCli {
  constructor(config, execute = executeCli) {
    this.config = config;
    this.execute = execute;
    this.queue = Promise.resolve();
  }

  async version() {
    const { stdout } = await this.execute(process.execPath, [cliEntry, '--version'], {
      cwd: this.config.root, encoding: 'utf8', timeout: 10000, maxBuffer,
    });
    return stdout.trim();
  }

  run(command, options = {}) {
    // SAP caches and refreshes OAuth credentials on disk. Avoid concurrent CLI writers.
    const pending = this.queue.then(() => this.runCommand(command, options));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async runCommand(command, { definition, signal, jsonOutput = true } = {}) {
    if (!this.config.host) {
      throw new Error('Configure DATASPHERE_HOST or host in datasphere.config.json, then sign in with npm run cli -- login --options-file oauth-options.json.');
    }
    if (signal?.aborted) throw new Error('Command cancelled before execution');
    const directory = await mkdtemp(path.join(tmpdir(), 'datasphere-mcp-'));
    try {
      const args = [cliEntry, ...command, `--host=${this.config.host}`];
      if (this.config.secretsFile) args.push(`--secrets-file=${this.config.secretsFile}`);
      if (definition !== undefined) {
        const file = path.join(directory, 'definition.json');
        await writeFile(file, JSON.stringify(definition), { mode: 0o600 });
        args.push(`--file-path=${file}`);
      }
      const output = path.join(directory, 'result.json');
      if (jsonOutput) args.push(`--output=${output}`, '--no-pretty');
      let stdout;
      try {
        ({ stdout } = await this.execute(process.execPath, args, {
          cwd: this.config.root,
          encoding: 'utf8',
          timeout: this.config.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer,
          signal,
          // No shell, terminal input, or CLI logs on MCP stdout. Keep error diagnostics only.
          env: { ...process.env, NO_COLOR: '1', LOG_LEVEL: '1', LOGGERS: '' },
        }));
      } catch (error) {
        // Do not include error.message: Node embeds the command line, including parameters.
        const detail = error.stderr || error.stdout || error.code || 'CLI process failed';
        const uncertain = error.killed || error.name === 'AbortError' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        throw new Error(redact(`Datasphere CLI failed: ${detail}`)
          + (uncertain ? ' The command may have reached the tenant. Check object/task status before retrying.' : '')
          + ' Check sign-in, space privileges, and tenant CLI command help.');
      }
      // SAP can exit 0 at an unanswered prompt after stdin closes. That did not
      // complete the command, even though the process return code is successful.
      const plainStdout = stdout.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[78])/g, '');
      if (/(?:^|\n)\s*\?\s+Provide a value for option\b/.test(plainStdout)) {
        throw new Error('Datasphere CLI requested interactive input instead of completing. Check the required command options in tenant CLI help.');
      }
      let content = stdout;
      if (jsonOutput) {
        try { content = await readFile(output, 'utf8'); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return redact(parseOutput(content));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
