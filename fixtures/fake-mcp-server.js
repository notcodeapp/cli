'use strict';
// Fake MCP stdio server for tests: answers initialize, tools/list, tools/call.
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // notification — no answer
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake-mcp', version: '0.0.1' }, capabilities: { tools: {} } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echoes text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  } else if (message.method === 'tools/call') {
    const text = String(message.params?.arguments?.text || '');
    if (!text) send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'text обязателен' }] } });
    else send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
  }
});
