'use strict';
// MCP (Model Context Protocol) client for the CLI: talks to local servers over
// stdio with line-delimited JSON-RPC 2.0. Server commands come from
// ~/.notcode/config.json → mcpServers: { name: { command, args?, env? } }.
// Every tool call still goes through the agent's approval callback.

const { spawn } = require('node:child_process');

const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_SERVERS = 12;
const MAX_TOOLS_PER_SERVER = 32;

class McpError extends Error {}

/// One connection per server process; lazily started, closed with kill().
class McpClient {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.child = null;
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
  }

  ensureProcess() {
    if (this.child) return this.child;
    if (typeof this.cfg.command !== 'string' || !this.cfg.command.trim()) {
      throw new McpError(`MCP-сервер «${this.name}»: пустая команда`);
    }
    this.child = spawn(this.cfg.command, Array.isArray(this.cfg.args) ? this.cfg.args : [], {
      env: { ...process.env, ...(this.cfg.env && typeof this.cfg.env === 'object' ? this.cfg.env : {}), NOTCODE_MCP: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => { /* drained: stderr must not block the pipe */ });
    this.child.on('error', (err) => this.#failAll(new McpError(`MCP-сервер «${this.name}» не запущен: ${err.message}`)));
    this.child.on('exit', () => this.#failAll(new McpError(`MCP-сервер «${this.name}» завершился`)));
    return this.child;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; } // ignore non-JSON chatter
      if (message && typeof message.id === 'number' && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new McpError(`MCP «${this.name}»: ${message.error.message || JSON.stringify(message.error)}`));
        else entry.resolve(message.result);
      }
    }
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params, timeoutMs) {
    const child = this.ensureProcess();
    const id = ++this.nextId;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP «${this.name}»: ${method} не ответил за ${Math.round(timeoutMs / 1000)} с`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(frame); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`MCP «${this.name}»: не удалось отправить запрос: ${err.message}`));
      }
    });
  }

  async connect() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'notcode-cli', version: require('../package.json').version },
    }, LIST_TIMEOUT_MS);
    // Notifications carry no id — the server never answers them.
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    } catch { /* best effort */ }
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {}, LIST_TIMEOUT_MS);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .filter(t => t && typeof t.name === 'string' && t.name)
      .slice(0, MAX_TOOLS_PER_SERVER)
      .map(t => ({
        name: t.name.slice(0, 64),
        description: typeof t.description === 'string' ? t.description.slice(0, 300) : '',
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
      }));
  }

  async callTool(tool, args) {
    const result = await this.request('tools/call', { name: tool, arguments: args || {} }, CALL_TIMEOUT_MS);
    if (result?.isError) {
      const text = Array.isArray(result?.content) ? result.content.map(c => c?.text || '').join('\n') : '';
      return { ok: false, error: (text || 'инструмент сообщил об ошибке').slice(0, MAX_OUTPUT_CHARS) };
    }
    const text = Array.isArray(result?.content)
      ? result.content.map(c => (typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n')
      : JSON.stringify(result ?? {});
    return { ok: true, output: text.slice(0, MAX_OUTPUT_CHARS) };
  }

  close() {
    if (!this.child) return;
    try { this.child.kill(); } catch { /* already gone */ }
    this.child = null;
  }
}

/// Reads mcpServers from the config store passed in (config.load()).
function serverConfigs(store) {
  const raw = store && typeof store.mcpServers === 'object' && store.mcpServers ? store.mcpServers : {};
  const names = Object.keys(raw).slice(0, MAX_SERVERS);
  const configs = [];
  for (const name of names) {
    const cfg = raw[name];
    if (!cfg || typeof cfg !== 'object' || typeof cfg.command !== 'string' || !cfg.command.trim()) continue;
    configs.push({
      name: name.slice(0, 48),
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String).slice(0, 32) : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
    });
  }
  return configs;
}

/// Connects to every configured server and returns tool bindings:
/// { alias, server, tool, description, client, inputSchema }.
/// Servers that fail to start are skipped (best effort) with a warning.
async function collectMcpTools(serverConfigsList, warn = () => {}) {
  const bindings = [];
  for (const cfg of serverConfigsList) {
    const client = new McpClient(cfg.name, cfg);
    try {
      await client.connect();
      const tools = await client.listTools();
      if (!tools.length) { client.close(); continue; }
      for (const tool of tools) {
        bindings.push({
          alias: `mcp_${cfg.name}_${tool.name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64),
          server: cfg.name,
          tool: tool.name,
          description: tool.description || `MCP tool ${tool.name} (${cfg.name})`,
          inputSchema: tool.inputSchema,
          client,
        });
      }
    } catch (error) {
      client.close();
      warn(error.message);
    }
  }
  return bindings;
}

function mcpDefinition(binding) {
  return {
    type: 'function',
    function: {
      name: binding.alias,
      description: `[MCP server: ${binding.server}] ${binding.description}`.slice(0, 400),
      parameters: binding.inputSchema && binding.inputSchema.type === 'object'
        ? binding.inputSchema
        : { type: 'object', properties: {} },
    },
  };
}

module.exports = { McpClient, McpError, serverConfigs, collectMcpTools, mcpDefinition, MAX_SERVERS };
