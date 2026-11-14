'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../lib/tools');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notcode-cli-'));
  return root;
}

test('resolveSafe держит пути внутри корня', () => {
  const root = tmpProject();
  const inside = tools.resolveSafe(root, 'src/app.js');
  assert.ok(inside.startsWith(path.resolve(root)));
  assert.throws(() => tools.resolveSafe(root, '../outside.txt'));
  assert.throws(() => tools.resolveSafe(root, '/etc/passwd'));
  assert.throws(() => tools.resolveSafe(root, 'a/../../b'));
  assert.throws(() => tools.resolveSafe(root, 'bad\0name'));
  assert.throws(() => tools.resolveSafe(root, '   '));
  fs.rmSync(root, { recursive: true, force: true });
});

test('unifiedDiff показывает изменения с контекстом', () => {
  const diff = tools.unifiedDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', 'file.txt');
  assert.ok(diff.includes('--- a/file.txt'));
  assert.ok(diff.includes('-c'));
  assert.ok(diff.includes('+X'));
  assert.ok(diff.includes(' b'));
  const same = tools.unifiedDiff('x\ny', 'x\ny', 'f');
  assert.ok(!same.includes('+') || !same.split('\n').some(l => l.startsWith('+') && !l.startsWith('+++')));
});

test('writeFile требует подтверждения и пишет только после него', async () => {
  const root = tmpProject();
  const calls = [];
  const approve = async (req) => { calls.push(req); return true; };
  const result = await tools.writeFile(root, 'src/new.txt', 'hello\n', approve);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'write');
  assert.equal(calls[0].isNew, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'hello\n');

  const denied = await tools.writeFile(root, 'src/new.txt', 'changed\n', async () => false);
  assert.equal(denied.denied, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'hello\n');

  const unchanged = await tools.writeFile(root, 'src/new.txt', 'hello\n', approve);
  assert.equal(unchanged.unchanged, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runCommand возвращает код и вывод, таймаут убивает процесс', async () => {
  const root = tmpProject();
  const ping = await tools.runCommand(root, 'echo ping', 10_000, async () => true);
  assert.equal(ping.ok, true);
  assert.ok(ping.stdout.includes('ping'));
  const slow = await tools.runCommand(
    root,
    process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30',
    1_000,
    async () => true,
  );
  assert.equal(slow.killed, true);
  const denied = await tools.runCommand(root, 'echo no', 1000, async () => false);
  assert.equal(denied.denied, true);
  fs.rmSync(root, { recursive: true, force: true });
});
