'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../lib/ui-menu');
const sessions = require('../lib/sessions');

test('баннер рисует NOTCODE блочными глифами', () => {
  const art = ui.banner('notcode');
  const lines = art.split('\n');
  assert.equal(lines.length, 6);
  assert.ok(art.includes('███╗   ██╗'));  // N
  assert.ok(art.includes('████████╗'));  // T
  assert.ok(art.includes('███████╗'));   // E
  // буквы идут слева направо: N до E
  assert.ok(art.indexOf('███╗   ██╗') < art.indexOf('███████╗'));
});

test('renderMenu: выделение, подсказки, прокрутка', () => {
  const items = [
    { label: 'Новый чат', hint: 'с нуля' },
    { label: 'Опасное', danger: true },
  ];
  const lines = ui.renderMenu('Чаты', items, 0, 12, 0).map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const text = lines.join('\n');
  assert.ok(text.includes('Чаты'));
  assert.ok(text.includes('▸ Новый чат'));
  assert.ok(text.includes('с нуля'));
  assert.ok(!text.includes('▸ Опасное'));
  // прокрутка: на 20 элементах со страницей 5 видно только 5
  const many = Array.from({ length: 20 }, (_, i) => ({ label: 'item' + i }));
  const scrolled = ui.renderMenu('L', many, 6, 5, 5).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(scrolled.includes('item6'));
  assert.ok(!scrolled.includes('item0\n') && !scrolled.includes(' item0'));
  assert.ok(scrolled.includes('10/20'));
});

test('sessions: save → list → load → remove', () => {
  const saved = sessions.save({ name: 'Тест чат', model: 'm1', messages: [{ role: 'user', content: 'привет' }] });
  assert.ok(saved.id);
  const listed = sessions.list();
  const found = listed.find(s => s.id === saved.id);
  assert.ok(found, 'сессия в списке');
  assert.equal(found.name, 'Тест чат');
  const loaded = sessions.load(saved.id);
  assert.equal(loaded.model, 'm1');
  assert.equal(loaded.messages[0].content, 'привет');
  sessions.remove(saved.id);
  assert.ok(!sessions.list().some(s => s.id === saved.id));
  void path; void fs;
});
