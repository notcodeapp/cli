'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/config');

test('config: save/load roundtrip и валидация baseUrl', () => {
  const file = config.configPath();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    config.save({ baseUrl: 'https://api.example.com/v1/', model: 'test-model', key: 'sk-test' });
    const loaded = config.load();
    assert.equal(loaded.baseUrl, 'https://api.example.com/v1');
    assert.equal(loaded.model, 'test-model');
    assert.equal(config.validateBaseUrl('https://ok.example.com'), null);
    assert.ok(config.validateBaseUrl('ftp://x'));
    assert.ok(config.validateBaseUrl('https://user:pw@x.com'));
    // env-ключ перекрывает сохранённый
    process.env.NOTCODE_API_KEY = 'env-key';
    const resolved = config.resolve();
    assert.equal(resolved.key, 'env-key');
    delete process.env.NOTCODE_API_KEY;
    assert.equal(config.resolve().key, 'sk-test');
  } finally {
    if (backup === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, backup); }
  }
});

test('agent: цикл с инструментом на фейковом провайдере', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notcode-agent-'));
  const llm = require('../lib/llm');
  const agent = require('../lib/agent');

  // 1-й ответ: модель зовёт write_file (один дельта-чанк); 2-й: финальный текст.
  const responses = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"hi\\n"}' } }] } }] },
    { choices: [{ delta: { content: 'Готово' } }] },
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
    const sse = ['data: ' + JSON.stringify(payload), 'data: [DONE]', ''].join('\n');
    return { ok: true, body: (async function* () { yield Buffer.from(sse); })(), text: async () => '' };
  };

  const deltas = [];
  const actions = [];
  const approvals = [];
  const result = await agent.runAgent({
    config: { baseUrl: 'https://fake.provider/v1', key: 'k', model: 'm' },
    root,
    task: 'создай hello.txt',
    approve: async (req) => { approvals.push(req); return true; },
    onDelta: t => deltas.push(t),
    onAction: a => actions.push(a),
    fetchImpl,
  });

  assert.ok(result.answer.includes('Готово'));
  assert.equal(calls.length, 2);              // tool-раунд + финальный ответ
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'write');
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'hi\n');
  assert.ok(deltas.join('').includes('Готово'));
  assert.ok(actions.some(a => a.name === 'write_file' && a.done));
  // история содержит tool-результат, привязанный к id вызова
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call-1');
  assert.ok(JSON.parse(toolMsg.content).ok === true);
  void llm;
  fs.rmSync(root, { recursive: true, force: true });
});

test('agent: отклонённое подтверждение доходит до модели', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notcode-agent-'));
  const agent = require('../lib/agent');
  const responses = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' } }] } }] },
    { choices: [{ delta: { content: 'Понял, не запускаю.' } }] },
  ];
  const fetchImpl = async (url, init) => {
    const payload = responses[Math.min(+calls, responses.length - 1)];
    calls++;
    const sse = ['data: ' + JSON.stringify(payload), 'data: [DONE]', ''].join('\n');
    return { ok: true, body: (async function* () { yield Buffer.from(sse); })(), text: async () => '' };
  };
  let calls = 0;
  const result = await agent.runAgent({
    config: { baseUrl: 'https://fake.provider/v1', key: 'k', model: 'm' },
    root,
    task: 'удали всё',
    approve: async () => false,
    fetchImpl,
  });
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(JSON.parse(toolMsg.content).denied === true);
  fs.rmSync(root, { recursive: true, force: true });
});
