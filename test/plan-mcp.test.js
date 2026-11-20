'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const agent = require('../lib/agent');
const mcp = require('../lib/mcp');
const config = require('../lib/config');
const chatUi = require('../lib/chat-ui');

// Фейковый провайдер: последовательность ответов через SSE (как в agent.test.js).
function fakeFetch(responses) {
  let calls = 0;
  return async (url, init) => {
    calls++;
    const payload = responses[Math.min(calls - 1, responses.length - 1)];
    const sse = ['data: ' + JSON.stringify(payload), 'data: [DONE]', ''].join('\n');
    return { ok: true, body: (async function* () { yield Buffer.from(sse); })(), text: async () => '' };
  };
}

test('agent: update_plan обновляет план и не требует подтверждения', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'notcode-plan-'));
  const responses = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'update_plan', arguments: '{"steps":[{"title":"Разобраться","status":"in_progress"},{"title":"Исправить","status":"pending"}]}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p2', function: { name: 'update_plan', arguments: '{"steps":[{"title":"Разобраться","status":"done"},{"title":"Исправить","status":"done"}]}' } }] } }] },
    { choices: [{ delta: { content: 'Всё готово' } }] },
  ];
  const plans = [];
  const approvals = [];
  const result = await agent.runAgent({
    config: { baseUrl: 'https://fake.provider/v1', key: 'k', model: 'm' },
    root,
    task: 'почини всё по шагам',
    approve: async req => { approvals.push(req); return true; },
    onPlan: steps => plans.push(steps),
    fetchImpl: fakeFetch(responses),
  });
  assert.equal(plans.length, 2);
  assert.equal(plans[0][0].status, 'in_progress');
  assert.deepEqual(plans[1].map(s => s.status), ['done', 'done']);
  assert.deepEqual(result.plan, plans[1]);           // финальное состояние возвращается
  assert.equal(approvals.length, 0);                 // план не требует подтверждений
  // в истории модель получает ok-ответы на update_plan
  const planResults = result.messages.filter(m => m.role === 'tool');
  assert.equal(planResults.length, 2);
  assert.equal(JSON.parse(planResults[0].content).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('agent: update_plan с пустыми steps отдаёт модели ошибку', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'notcode-plan-'));
  const responses = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p3', function: { name: 'update_plan', arguments: '{"steps":[]}' } }] } }] },
    { choices: [{ delta: { content: 'ок' } }] },
  ];
  const result = await agent.runAgent({
    config: { baseUrl: 'https://fake.provider/v1', key: 'k', model: 'm' },
    root,
    task: 'план',
    approve: async () => true,
    onPlan: () => { throw new Error('не должно вызываться'); },
    fetchImpl: fakeFetch(responses),
  });
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(JSON.parse(toolMsg.content).error.includes('update_plan'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat-ui: planLines рисует статусы и не ломается на пустом списке', () => {
  const lines = chatUi.planLines([
    { title: 'Готовый шаг', status: 'done' },
    { title: 'В работе', status: 'in_progress' },
    { title: 'Ждёт', status: 'pending' },
  ]);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('План'));
  assert.ok(lines[1].includes('1. Готовый шаг'));
  assert.ok(chatUi.planLines([]).length === 1);
});

// ---- MCP клиент против фейкового stdio-сервера --------------------------------

test('mcp: connect → tools/list → tools/call через JSON-RPC поверх stdio', async () => {
  const server = nodePath.join(__dirname, '..', 'fixtures', 'fake-mcp-server.js');
  const client = new mcp.McpClient('test', { command: process.execPath, args: [server] });
  try {
    const init = await client.connect();
    assert.equal(init.serverInfo.name, 'fake-mcp');
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
    const result = await client.callTool('echo', { text: 'привет' });
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('привет'));
    const bad = await client.callTool('echo', { text: '' });
    assert.equal(bad.ok, false); // isError от сервера
  } finally {
    client.close();
  }
});

test('mcp: сервер, который молчит, не вешает collectMcpTools', async () => {
  // node без аргументов просто ждёт stdin — initialize не ответит.
  const bindings = await mcp.collectMcpTools(
    [{ name: 'silent', command: process.execPath, args: ['--interactive'] }],
    () => {},
  );
  assert.equal(bindings.length, 0);
}, { timeout: 30000 });

test('config: mcpServers сохраняется и санитизируется', () => {
  const file = config.configPath();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    config.save({ mcpServers: { files: { command: 'node', args: ['srv.js'] }, broken: 'не объект', empty: { command: '' } } });
    const loaded = config.load();
    assert.deepEqual(loaded.mcpServers, { files: { command: 'node', args: ['srv.js'] } });
    config.save({ mcpServers: {} });
    assert.equal(config.load().mcpServers, undefined);
  } finally {
    if (backup === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(nodePath.dirname(file), { recursive: true }); fs.writeFileSync(file, backup); }
  }
});
