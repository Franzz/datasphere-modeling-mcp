# Datasphere modeling MCP

An independent MCP server for SAP Datasphere as a BW migration target. It wraps the pinned official `@sap/datasphere-cli` package; it is a custom integration, not an SAP-supported MCP server. Node.js 22–24 is required.

## Setup

From this directory:

```bash
npm run build
cp datasphere.config.example.json datasphere.config.json
cp oauth-options.example.json oauth-options.json
chmod 600 oauth-options.json
```

Set your tenant URL (`host`) and migration `space` in `datasphere.config.json`. Put the OAuth client ID and secret from Datasphere in `oauth-options.json`; the CLI launcher automatically passes the configured tenant host when signing in. SAP's CLI derives the authorization and token URLs from that host by default. If the derived URLs do not match your tenant's authentication setup, add `authorization-url` and `token-url` to `oauth-options.json` using the values shown under System → Administration → App Integration. The examples contain placeholders only. The real configuration, credentials, dependency folder, and `.datasphere/` folder are ignored by git.

Log in through SAP's CLI in a terminal:

```bash
npm run cli -- login --options-file oauth-options.json
npm run cli -- spaces list
```

For Firefox, use `npm run cli -- login --options-file oauth-options.json --browser firefox`. On WSL, the launcher reads Firefox's Windows registration, including installations under your Windows user profile. It receives the callback on `http://localhost:8080/`, validates the login state, and passes the code to SAP's CLI for token exchange and session storage. The browser can remain open while you complete sign-in; this launcher allows five minutes. Windows-to-WSL localhost forwarding must be available.

If this terminal runs on a server, container, or machine without a browser (for example, `spawn google chrome ENOENT`), use manual sign-in:

```bash
npm run cli -- login --manual --options-file oauth-options.json
```

Open the printed link in a browser on your computer. After signing in, copy the complete `http://localhost:8080/?code=...&state=...` URL from the browser address bar into the waiting terminal prompt. A browser error saying localhost cannot be reached is expected when the terminal is on another machine; the URL still carries the callback. Input is hidden. Keep the callback out of chat and logs. Register `http://localhost:8080/` as the OAuth client's redirect URI. This mode validates the login state and gives SAP's CLI the code through a private temporary options file, which is removed afterwards. SAP's CLI still handles the token exchange, session storage, and cache initialization.

The manual mode applies to Interactive Usage clients. Technical User clients use `client_credentials` without a browser. Explicit authorization/token URL overrides remain supported for tenant-specific setups.

The example uses an **Interactive Usage** OAuth client with `authorization_code`. SAP also documents `client_credentials` for a **Technical User** client; use the client purpose, grants and space privileges appropriate to the commands you need. Technical-user support varies by operation. The CLI manages its session and refresh tokens in its standard user cache (`~/.@sap/datasphere-cli/.cache`). MCP uses the same OS user's session. Re-run login when authentication expires or is revoked. CLI discovery is tenant-specific; refresh it when necessary with:

```bash
npm run cli -- config cache init
npm run cli -- objects views --help
```

For modeling, the user needs access to the space, Data Warehouse General read, Space Files CRUD and the appropriate Data Builder privileges. Task runs also need Data Integration privileges and, for interactive users, Datasphere task consent. The MCP does not grant SAP permissions.

In the parent repository, run `npm run build`, select **SAP Datasphere**, then restart your MCP host. The parent creates the `datasphere-mcp` entry in its `.mcp.json`. This folder remains its own git repository; the parent ignores all of `modeling-mcp/`.

Standalone: `npm start` runs the stdio server. `npm run build` installs dependencies and prints an MCP configuration entry. It does not sign in, connect to a tenant, or deploy models. The parent imports the exported `build()` and uses the returned entry. No separate compilation step is required for these JavaScript sources.

## Configuration

Environment variables override `datasphere.config.json`:

| Environment variable | JSON property | Default / purpose |
|---|---|---|
| `DATASPHERE_HOST` | `host` | Required for tenant tools; HTTPS tenant URL |
| `DATASPHERE_SPACE` | `space` | Optional default space; tools can specify another space |
| `DATASPHERE_STDIO_SCOPES` | `scopes` | `read,write` |
| `DATASPHERE_SECRETS_FILE` | `secretsFile` | Optional SAP CLI secrets file; otherwise reuse the CLI session |
| `DATASPHERE_TIMEOUT_MS` | `timeoutMs` | `120000`, from 1000 to 900000 |
| `DATASPHERE_CONFIG_FILE` | — | Optional config path; defaults to this repo's `datasphere.config.json` |

Relative environment paths resolve against this repo. A relative `secretsFile` in JSON resolves against that JSON file's directory. Keep credentials in the CLI cache or a protected, ignored secrets file; put only its path in MCP configuration. CLI secrets files use SAP's underscore field names (for example `access_token`, `refresh_token`, `client_id`, `client_secret`), unlike login options files. Use SAP's documented format for the selected authorization flow.

Scopes control which tools are advertised and callable. `read` is always included; `write`, `execute`, and `delete` are independent. For read-only use, set scopes to `read`. The build preserves existing `datasphere-mcp.env` values; explicitly supplied environment settings override them. If neither environment nor local configuration sets scopes, the server defaults to `read,write`.

## Tools

| Tool | Scope | Behavior |
|---|---|---|
| `datasphere_status` | read | Local CLI version/configuration; no tenant request |
| `datasphere_cli_help` | read | Tenant-specific help for objects, spaces or tasks |
| `datasphere_list_spaces` | read | Accessible spaces; checks sign-in |
| `datasphere_list_objects` | read | Paginated inventory and deployment status by object type |
| `datasphere_read_object` | read | Design-time, run-time or complete CSN/JSON |
| `datasphere_create_object` | write | Create from a JSON definition; `deploy` defaults to `false` |
| `datasphere_update_object` | write | Replace an existing definition; `deploy` defaults to `false` |
| `datasphere_delete_object` | delete | Delete an object with SAP dependency checks enabled |
| `datasphere_run_task_chain` | execute | Start a deployed task chain with optional string parameters |
| `datasphere_list_task_logs` | read | Object run history |
| `datasphere_get_task_log` | read | Status/details for one run |

Supported object categories: local/remote tables, views, analytic models, data/replication/transformation flows, task chains, data access controls, intelligent lookups, ER models, types, contexts, business entities, fact models and consumption models. Actual operations depend on your tenant's discovery document. SAP notes that types/contexts are imported with other content rather than manually created; their presence in the read category list does not guarantee a standalone create operation.

Example create arguments:

```json
{
  "space": "BW_MIGRATION",
  "object_type": "local-tables",
  "technical_name": "Z_CUSTOMER",
  "deploy": false,
  "definition": {
    "definitions": {
      "Z_CUSTOMER": {
        "kind": "entity",
        "@EndUserText.label": "Customer",
        "@ObjectModel.modelingPattern": { "#": "DATA_STRUCTURE" },
        "@ObjectModel.supportedCapabilities": [{ "#": "DATA_STRUCTURE" }],
        "elements": {
          "ID": { "type": "cds.String", "length": 10, "key": true, "notNull": true }
        }
      }
    }
  }
}
```

To deploy, call update with the full reviewed definition and `deploy=true`. There is no invented CLI deploy endpoint: SAP's create/update commands deploy unless `--no-deploy` is supplied. Read/list afterwards to check deployment status. An execution tool returning a run ID means the run was submitted; inspect task logs to determine completion.

## Migration workflow and limits

1. Read the source BW model through the BW MCP.
2. Read a suitable Datasphere template through this MCP and generate its target CSN/JSON, including required annotations and editor settings.
3. Create sources before dependent views and analytic models. Connections for remote tables must already exist.
4. Save drafts, review, then update with `deploy=true` and inspect deployment status.
5. If execution scope is enabled, run the task chain and inspect its logs.

This server provides target operations. It does not automatically translate BW models/routines, move BW data, or reconcile query results. Those require migration logic and the relevant Datasphere connections/extraction or loading mechanisms. The CLI expects one object's definition per create/update; a UI export containing all dependencies must be split and applied in dependency order. Read real object templates instead of assuming generic CDS is sufficient for every graphical object or analytic model.

Commands run without a shell and with closed stdin under MCP. Definitions and results use private temporary directories, which are removed after each command. CLI calls are serialized to reduce refresh-token/cache races, bounded by timeout and output limits, and not retried automatically. A timeout/cancellation can leave a tenant operation running: inspect status before retrying. CLI errors become MCP tool errors. Credential keys are redacted from returned results and errors, but model metadata itself is intentionally returned. Normal tool calls never invoke interactive login or expose a general command runner.

## Development

```bash
npm run check
npm test
```

Tests exercise CLI argument isolation, file cleanup, deployment switches, scopes, errors/cancellation, and a real MCP client/server exchange against a synthetic CLI executor. They require no tenant or credentials. Live tenant validation remains a separate step after authentication.

Official references:

- [SAP Datasphere CLI](https://www.npmjs.com/package/@sap/datasphere-cli)
- [Modeling objects and dependency rules](https://help.sap.com/docs/SAP_DATASPHERE/d0ecd6f297ac40249072a44df0549c1a/e3b2cbef9d1f4b38b51c64fe9e88c0aa.html)
- [OAuth and CLI options](https://help.sap.com/docs/SAP_DATASPHERE/d0ecd6f297ac40249072a44df0549c1a/d483a0f480af452e9dda47f885ab87ad.html)
- [Task commands](https://help.sap.com/docs/SAP_DATASPHERE/d0ecd6f297ac40249072a44df0549c1a/2b26a31f197444dea314495bc0008eae.html)
