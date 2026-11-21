'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const local = require('../lib/local-models');

test('recommend: 8 ГБ RAM без GPU — 7B код-модели рекомендуются, 32B за гранью', () => {
  const result = local.recommend({ ramGb: 8, gpu: null, vramGb: 0 });
  assert.equal(result.budget, 5.5);
  assert.ok(result.recommended.length > 0);
  assert.ok(result.recommended.every((m) => m.ramGb <= 5.5));
  // qwen2.5-coder:7b требует 6 ГБ → не влезает в бюджет 5.5
  assert.ok(!result.recommended.some((m) => m.name === 'qwen2.5-coder:7b'));
  assert.ok(result.beyond.some((m) => m.name === 'qwen2.5-coder:32b'));
  // код-модели идут раньше универсальных
  const codingIndexes = result.recommended.map((m, i) => (m.coding ? i : 999));
  assert.ok(codingIndexes[0] <= result.recommended.findIndex((m) => !m.coding));
});

test('recommend: 64 ГБ RAM + VRAM — 32B код-модель рекомендована', () => {
  const result = local.recommend({ ramGb: 64, gpu: 'NVIDIA RTX', vramGb: 16 });
  assert.ok(result.recommended.some((m) => m.name === 'qwen2.5-coder:32b'));
  // всё, что влезло, не должно быть за гранью
  for (const model of result.recommended) {
    assert.ok(!result.beyond.some((b) => b.name === model.name));
  }
});

test('recommend: установленные помечены', () => {
  const result = local.recommend({ ramGb: 64, gpu: null, vramGb: 0 }, local.LOCAL_CATALOG, ['mistral:7b']);
  const mistral = [...result.recommended, ...result.beyond].find((m) => m.name === 'mistral:7b');
  assert.equal(mistral.installed, true);
});

test('parsePullLine: прогресс, финал и мусор', () => {
  assert.deepEqual(local.parsePullLine('{"status":"pulling manifest"}'), { status: 'pulling manifest' });
  const mid = local.parsePullLine('{"status":"downloading sha256:abc","digest":"sha256:abc","total":4700000000,"completed":2350000000}');
  assert.equal(mid.fraction, 0.5);
  assert.equal(mid.totalBytes, 4700000000);
  assert.deepEqual(local.parsePullLine('{"status":"success"}'), { done: true });
  assert.equal(local.parsePullLine('not json'), null);
  assert.equal(local.parsePullLine(''), null);
});

test('каталог: уникальные имена, положительный вес, есть код-модели', () => {
  const names = local.LOCAL_CATALOG.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(local.LOCAL_CATALOG.every((m) => m.ramGb > 0 && m.note.length > 3));
  assert.ok(local.LOCAL_CATALOG.some((m) => m.coding));
});

test('usableMemoryGb: RAM минус запас, VRAM прибавляется', () => {
  assert.equal(local.usableMemoryGb({ ramGb: 16, vramGb: 0 }), 13.5);
  assert.equal(local.usableMemoryGb({ ramGb: 16, vramGb: 8 }), 21.5);
});
