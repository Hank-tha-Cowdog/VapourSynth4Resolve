// Local MCP server — exposes the popout's restoration tools to any MCP client
// (Claude Code, Claude Desktop, external agent orchestrators).
//
// Transport: Streamable HTTP in STATELESS mode on 127.0.0.1 (loopback only) —
// a GUI app can't be stdio-spawned by MCP clients, so HTTP is the natural fit.
// Each POST gets a fresh Server+transport pair (the SDK's documented stateless
// pattern); tool state lives in main-process closures, not sessions.
//
// SECURITY (2026-11-05, security review #3): every request must present the
// per-launch bearer token (Authorization: Bearer <token> or X-VSRES-MCP-Token).
// The token is generated fresh at each server start and returned to the
// caller; main.js logs it with the registration command. Without it, ANY
// local process could read chain/source state or edit the chain.
//
// Register with Claude Code (token from the app's startup log):
//   claude mcp add --transport http vapoursynth-restoration \
//     --header "Authorization: Bearer <TOKEN>" \
//     http://127.0.0.1:8799/mcp
// (8799 chosen to stay clear of common local services — e.g. whisper-server
//  conventionally sits on 8765. Override with VSRES_MCP_PORT.)
//
// Tools = shared registry (probe_source, get_chain_state, get_plugin_status,
// render_sample) + apply_chain_edit, which bridges into the renderer's chain-ops
// so MCP edits flow through the exact same code path as Skippy edits.

const http = require('http');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const DEFAULT_PORT = 8799;

// apply_chain_edit is MCP-only (Skippy has its own propose_chain_edit UI
// flow); schema mirrors propose_chain_edit's operations shape.
const APPLY_CHAIN_EDIT_DEF = {
  name: 'apply_chain_edit',
  description: 'Apply add/update/remove operations to the filter chain in the open popout window. '
    + 'Edits go through the same chain-ops code path as Skippy\'s proposals and live-sync '
    + 'back to the OFX plugin. Requires the popout window to be open. Use get_chain_state first '
    + 'to learn existing step ids for update/remove. The result includes renderVerification — '
    + 'the VS evaluation verdict from the next render/preview. state "chain-error" means the '
    + 'chain is NOT running (silent passthrough): fix the reported error and re-apply. state '
    + '"unverified" means no render happened within the wait window — check get_plugin_status '
    + 'after triggering a preview or moving the playhead.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: 'Short human-readable description, shown in the chat log.' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove'] },
            target_id: { type: 'string', description: 'For update/remove: existing step id.' },
            step: {
              type: 'object',
              description: 'For add: { type:"script", stage:10..90, label, code }.',
              properties: {
                type:  { type: 'string', enum: ['script'] },
                stage: { type: 'integer' },
                label: { type: 'string' },
                code:  { type: 'string' },
              },
              required: ['type', 'stage', 'code'],
            },
            code:  { type: 'string' },
            stage: { type: 'integer' },
            label: { type: 'string' },
          },
          required: ['op'],
        },
      },
    },
    required: ['operations'],
  },
};

/**
 * @param {object} opts
 * @param {Array}  opts.toolDefinitions  Claude-format defs from the registry
 * @param {(name: string, input: object) => Promise<object>} opts.execute
 * @param {(payload: {operations: Array, explanation?: string}) => Promise<object>} opts.requestChainEdit
 */
function startMcpServer({ toolDefinitions, execute, requestChainEdit }) {
  const port = Number(process.env.VSRES_MCP_PORT) || DEFAULT_PORT;
  // Per-launch bearer token (security review #3): fresh 192-bit random value;
  // required on every request. Returned to the caller for surfacing.
  const token = crypto.randomBytes(24).toString('base64url');
  const allDefs = [...toolDefinitions, APPLY_CHAIN_EDIT_DEF];

  function buildServer() {
    const server = new Server(
      { name: 'vapoursynth-restoration', version: '2.0.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allDefs.map(d => ({
        name: d.name,
        description: d.description,
        inputSchema: d.input_schema,   // MCP camelCase ← Claude snake_case
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      let result;
      try {
        result = name === 'apply_chain_edit'
          ? await requestChainEdit(args || {})
          : await execute(name, args || {});
      } catch (e) {
        result = { ok: false, error: e?.message || String(e) };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result && result.ok === false,
      };
    });

    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    // AUTH (security review #3): refuse requests without the per-launch token
    // BEFORE any tool dispatch. Loopback-only transport plus this check
    // closes the audited "any local process can call the tools" hole.
    const auth = req.headers.authorization || '';
    const alt = req.headers['x-vsres-mcp-token'];
    if (auth !== `Bearer ${token}` && alt !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unauthorized: missing or invalid MCP bearer token' },
        id: null,
      }));
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no SSE resumption stream, no sessions to delete.
      res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server — POST only)' },
        id: null,
      }));
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;

      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      console.error('[mcp] request failed:', e?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      }
    }
  });

  return new Promise((resolve) => {
    httpServer.once('error', (e) => {
      // EADDRINUSE = another popout instance already serves MCP. Non-fatal.
      console.warn(`[mcp] not started (${e.code || e.message}) — port ${port} busy?`);
      resolve(null);
    });
    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[mcp] vapoursynth-restoration MCP server on http://127.0.0.1:${port}/mcp`);
      resolve({ httpServer, port, token });
    });
  });
}

module.exports = { startMcpServer };
