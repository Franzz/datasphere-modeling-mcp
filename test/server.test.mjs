import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DatasphereCli } from '../src/cli.mjs';
import { createTools, registerTools } from '../src/tools.mjs';
import { projectDir } from '../src/config.mjs';

const baseConfig = { root: projectDir, host: 'https://example.invalid', space: 'MIGRATION', timeoutMs: 5000, scopes: new Set(['read', 'write']) };

async function connect(t, config = baseConfig, execute = async () => ({ stdout: '{"ok":true}' })) {
  const server = new McpServer({ name: 'test-datasphere', version: '0.1.0' });
  registerTools(server, new DatasphereCli(config, execute), config);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP handshake, discovery, read-only scope enforcement, validation, and tool errors', async (t) => {
  const config = { ...baseConfig, scopes: new Set(['read']), space: undefined };
  let calls = 0;
  const client = await connect(t, config, async () => { calls++; return { stdout: '{"spaces":["MIGRATION"]}' }; });
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 7);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(tools.every((tool) => !/create|update|delete|run_task/.test(tool.name)));
  const list = await client.callTool({ name: 'datasphere_list_spaces', arguments: {} });
  assert.deepEqual(JSON.parse(list.content[0].text), { spaces: ['MIGRATION'] });
  assert.equal(calls, 1);
  const forbidden = await client.callTool({ name: 'datasphere_create_object', arguments: {} });
  assert.equal(forbidden.isError, true);
  const missingSpace = await client.callTool({ name: 'datasphere_list_objects', arguments: { object_type: 'views' } });
  assert.equal(missingSpace.isError, true);
  const invalid = await client.callTool({ name: 'datasphere_list_objects', arguments: { object_type: 'arbitrary-command' } });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 1);
});

test('MCP creates a draft, deploys an update, paginates inventory, and uses SAP task argument names', async (t) => {
  const commands = [];
  const config = { ...baseConfig, scopes: new Set(['read', 'write', 'execute', 'delete']) };
  const client = await connect(t, config, async (_, args) => { commands.push(args); return { stdout: '{"ok":true}' }; });
  const definition = { definitions: { TEST: { kind: 'entity' } } };
  const args = { object_type: 'local-tables', technical_name: 'TEST', definition };
  const draft = await client.callTool({ name: 'datasphere_create_object', arguments: args });
  assert.ok(!draft.isError);
  assert.ok(commands.at(-1).includes('--no-deploy'));
  assert.ok(commands.at(-1).includes('--space=MIGRATION'));
  const update = await client.callTool({ name: 'datasphere_update_object', arguments: { ...args, deploy: true } });
  assert.ok(!update.isError);
  assert.ok(!commands.at(-1).includes('--no-deploy'));
  await client.callTool({ name: 'datasphere_list_objects', arguments: { object_type: 'views', top: 25, skip: 50 } });
  assert.ok(commands.at(-1).includes('--top=25'));
  assert.ok(commands.at(-1).includes('--skip=50'));
  await client.callTool({ name: 'datasphere_read_object', arguments: { object_type: 'views', technical_name: 'TEST' } });
  assert.ok(commands.at(-1).includes('--accept=application/vnd.sap.datasphere.object.content.design-time+json'));
  await client.callTool({ name: 'datasphere_run_task_chain', arguments: { technical_name: 'LOAD', input_parameters: { YEAR: '2026' } } });
  assert.ok(commands.at(-1).includes('--object=LOAD'));
  assert.ok(commands.at(-1).includes('--input-parameters={"YEAR":"2026"}'));
  await client.callTool({ name: 'datasphere_list_task_logs', arguments: { technical_name: 'LOAD' } });
  assert.ok(commands.at(-1).includes('--objectname=LOAD'));
  await client.callTool({ name: 'datasphere_get_task_log', arguments: { log_id: '123' } });
  assert.ok(commands.at(-1).includes('--log-id=123'));
  await client.callTool({ name: 'datasphere_delete_object', arguments: { object_type: 'local-tables', technical_name: 'TEST' } });
  assert.ok(commands.at(-1).includes('--force'));
  assert.ok(!commands.at(-1).includes('--delete-anyway'));
});

test('write scope does not grant execution or deletion; errors stay MCP tool errors', async (t) => {
  const tools = createTools({}, baseConfig);
  assert.ok(!tools.some((tool) => tool.scope === 'execute' || tool.scope === 'delete'));
  const client = await connect(t, baseConfig, async () => { throw { stderr: '403: insufficient privileges' }; });
  const result = await client.callTool({ name: 'datasphere_list_spaces', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /403: insufficient privileges/);
});

test('actual stdio entry starts without credentials and reports missing tenant as a tool error', async (t) => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${projectDir}/src/stdio.mjs`], env: { PATH: process.env.PATH, DATASPHERE_CONFIG_FILE: '/tmp/nonexistent-datasphere-config.json' }, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const status = await client.callTool({ name: 'datasphere_status', arguments: {} });
  assert.ok(!status.isError);
  assert.equal(JSON.parse(status.content[0].text).cli_version, '2026.22.0');
  const result = await client.callTool({ name: 'datasphere_list_spaces', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DATASPHERE_HOST/);
});
