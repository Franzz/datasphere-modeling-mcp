#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { DatasphereCli } from './cli.mjs';
import { registerTools } from './tools.mjs';

try {
  const config = loadConfig();
  const server = new McpServer({ name: 'datasphere-modeling-mcp', version: '0.1.0' }, {
    instructions: 'SAP Datasphere migration target backed by the official SAP CLI. Read templates before generating CSN/JSON. Create sources before their dependent models. Writes save drafts unless deploy=true. Check status and task logs after deployment or execution. Configure authentication outside MCP with npm run cli. Never retry an uncertain write automatically.',
  });
  registerTools(server, new DatasphereCli(config), config);
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`[datasphere-mcp] ${error.message}\n`);
  process.exitCode = 1;
}
