import { z } from 'zod';
import { redact } from './cli.mjs';

export const objectTypes = [
  'local-tables', 'remote-tables', 'views', 'analytic-models', 'data-flows',
  'replication-flows', 'transformation-flows', 'task-chains', 'data-access-controls',
  'intelligent-lookups', 'er-models', 'types', 'contexts', 'business-entities',
  'fact-models', 'consumption-models',
];
const identifier = z.string().min(1).max(256).regex(/^(?!-)[^\x00-\x1f]+$/, 'Invalid identifier');
const spaceField = identifier.optional().describe('Space ID; defaults to DATASPHERE_SPACE when configured.');
const objectType = z.enum(objectTypes).describe('Prefer replication-flows for source ingestion and transformation-flows for local-table transformations. Data flows remain supported for existing workflows.');
const targetFields = { space: spaceField, object_type: objectType, technical_name: identifier };
const definitionField = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, 'Definition cannot be empty');
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function createTools(cli, config) {
  const spaceOf = (args) => {
    const space = args.space || config.space;
    if (!space) throw new Error('Provide space or configure DATASPHERE_SPACE');
    return space;
  };
  const target = (args) => [`--space=${spaceOf(args)}`, `--technical-name=${args.technical_name}`];
  const definitions = [
    {
      name: 'datasphere_status', scope: 'read', schema: z.object({}),
      description: 'Check local CLI version and configuration without connecting to the tenant. Use list_spaces to check authentication.',
      annotations: readAnnotations,
      run: async () => ({ cli_version: await cli.version(), host: config.host ?? null, default_space: config.space ?? null, scopes: [...config.scopes], authentication: config.secretsFile ? 'secrets-file' : 'SAP CLI cached session' }),
    },
    {
      name: 'datasphere_cli_help', scope: 'read',
      description: 'Read tenant-specific CLI help. Supported commands and options depend on the tenant and its discovery cache. This tool only requests help.',
      schema: z.object({ category: z.enum(['objects', 'spaces', 'tasks']).default('objects'), object_type: objectType.optional() }),
      annotations: readAnnotations,
      run: (args, extra) => cli.run([args.category, ...(args.category === 'objects' && args.object_type ? [args.object_type] : []), '--help'], { signal: extra.signal, jsonOutput: false }),
    },
    {
      name: 'datasphere_list_spaces', scope: 'read', schema: z.object({}),
      description: 'List spaces accessible to the signed-in Datasphere user. Also checks tenant connectivity and authentication.',
      annotations: readAnnotations,
      run: (_, extra) => cli.run(['spaces', 'list'], { signal: extra.signal }),
    },
    {
      name: 'datasphere_list_objects', scope: 'read',
      description: 'List a page of modeling objects and their deployment status. Advance skip by top until exhausted. Sources must exist before dependent models can be created.',
      schema: z.object({ space: spaceField, object_type: objectType, top: z.number().int().min(1).max(200).default(100), skip: z.number().int().min(0).default(0), filter: z.string().max(4000).optional() }),
      annotations: readAnnotations,
      run: (args, extra) => cli.run(['objects', args.object_type, 'list', `--space=${spaceOf(args)}`, `--top=${args.top}`, `--skip=${args.skip}`, '--select=technicalName,businessName,type,semanticUsage,status', ...(args.filter ? [`--filter=${args.filter}`] : [])], { signal: extra.signal }),
    },
    {
      name: 'datasphere_read_object', scope: 'read',
      description: 'Read a modeling object as CSN/JSON. Use design-time for editable templates (including local-table delta capture objects); run-time reads the deployed version.',
      schema: z.object({ ...targetFields, version: z.enum(['design-time', 'run-time', 'complete']).default('design-time') }),
      annotations: readAnnotations,
      run: (args, extra) => cli.run(['objects', args.object_type, 'read', ...target(args), `--accept=application/vnd.sap.datasphere.object.content${args.version === 'complete' ? '' : `.${args.version}`}+json`], { signal: extra.signal }),
    },
    ...['create', 'update'].map((operation) => ({
      name: `datasphere_${operation}_object`, scope: 'write',
      description: `${operation === 'create' ? 'Create a new' : 'Replace the definition of an existing'} modeling object from one object\'s CSN/JSON, including required editorSettings and annotations. Sources must already exist. Saves without deploying by default; set deploy=true to save and deploy. This is not a BW-to-Datasphere converter.`,
      schema: z.object({ ...targetFields, definition: definitionField, deploy: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: operation === 'update', idempotentHint: false, openWorldHint: true },
      run: (args, extra) => cli.run(['objects', args.object_type, operation, ...target(args), ...(args.deploy ? [] : ['--no-deploy'])], { definition: args.definition, signal: extra.signal }),
    })),
    {
      name: 'datasphere_delete_object', scope: 'delete',
      description: 'Delete one modeling object. Can remove data. SAP dependency checks remain enabled; dependent objects are not force-deleted.',
      schema: z.object(targetFields),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: (args, extra) => cli.run(['objects', args.object_type, 'delete', ...target(args), '--force'], { signal: extra.signal }),
    },
    {
      name: 'datasphere_run_task_chain', scope: 'execute',
      description: 'Start a deployed task chain. May load, transform, or delete data according to its definition. Returns the run ID when supplied by SAP; monitor via task logs. Interactive users may need Datasphere task consent.',
      schema: z.object({ space: spaceField, technical_name: identifier, input_parameters: z.record(z.string(), z.string()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: (args, extra) => cli.run(['tasks', 'chains', 'run', `--space=${spaceOf(args)}`, `--object=${args.technical_name}`, ...(args.input_parameters ? [`--input-parameters=${JSON.stringify(args.input_parameters)}`] : [])], { signal: extra.signal }),
    },
    {
      name: 'datasphere_list_task_logs', scope: 'read',
      description: 'List execution history and run IDs for an object, such as a task chain.',
      schema: z.object({ space: spaceField, technical_name: identifier }),
      annotations: readAnnotations,
      run: (args, extra) => cli.run(['tasks', 'logs', 'list', `--space=${spaceOf(args)}`, `--objectname=${args.technical_name}`], { signal: extra.signal }),
    },
    {
      name: 'datasphere_get_task_log', scope: 'read',
      description: 'Read status or details of a task run by its log ID. A successful start command does not imply successful execution.',
      schema: z.object({ space: spaceField, log_id: identifier, info_level: z.enum(['status', 'details']).default('details') }),
      annotations: readAnnotations,
      run: (args, extra) => cli.run(['tasks', 'logs', 'get', `--space=${spaceOf(args)}`, `--log-id=${args.log_id}`, `--info-level=${args.info_level}`], { signal: extra.signal }),
    },
  ];
  return definitions.filter((tool) => config.scopes.has(tool.scope));
}

export function registerTools(server, cli, config) {
  for (const tool of createTools(cli, config)) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema, annotations: tool.annotations,
    }, async (args, extra) => {
      try {
        const result = await tool.run(args, extra);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: redact(error.message) }] };
      }
    });
  }
}
