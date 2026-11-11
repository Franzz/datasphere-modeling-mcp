#!/usr/bin/env node
// Interactive access to SAP's unmodified CLI, separate from MCP's closed stdin.
import { loadConfig } from '../src/config.mjs';
import { manualLogin, runInteractiveCli } from '../src/manual-login.mjs';
import { wslFirefoxLogin } from '../src/browser-login.mjs';

try {
  const config = loadConfig();
  const args = process.argv.slice(2);
  if (args.includes('--manual') && (args.includes('--help') || args.includes('-h'))) {
    process.stdout.write('Usage: npm run cli -- login --manual --options-file oauth-options.json\nPrints a browser link and prompts for its complete localhost callback URL.\n');
    process.exit(0);
  }
  if (args.includes('--manual') && args[0] !== 'login') throw new Error('--manual is supported only for login.');
  const hasOption = (name) => args.some((arg) => arg === name || arg.startsWith(`${name}=`));
  if (config.host && !hasOption('--host') && !hasOption('-H')) args.push(`--host=${config.host}`);
  if (config.secretsFile && !hasOption('--secrets-file') && !hasOption('-s')) args.push(`--secrets-file=${config.secretsFile}`);
  const firefox = args.some((arg, index) => arg === '--browser=firefox' || (arg === '--browser' && args[index + 1] === 'firefox'));
  const wsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);
  if (args.includes('--manual')) process.exitCode = await manualLogin(args, config);
  else if (args[0] === 'login' && firefox && wsl) process.exitCode = await wslFirefoxLogin(args, config);
  else process.exitCode = await runInteractiveCli(args, config);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
