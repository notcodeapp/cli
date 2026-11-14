#!/usr/bin/env node
'use strict';
// NotCode CLI entry point.
//   notcode                     — интерактивная сессия в текущей папке
//   notcode run "задача"        — одна задача от начала до конца
//   notcode models              — проверить подключение и список моделей
//   notcode config set k v      — baseUrl | model | key
//   notcode config show

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const config = require('../lib/config');
const tools = require('../lib/tools');

// ---- tiny UI ----------------------------------------------------------------

const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR;
const C = NO_COLOR ? { accent: '', dim: '', text: '', red: '', reset: '' } : {
  accent: '\x1b[38;5;154m', dim: '\x1b[90m', text: '\x1b[97m', red: '\x1b[91m', reset: '\x1b[0m',
};
const say = (text = '') => process.stdout.write(text + '\n');
const dim = (text) => say(C.dim + text + C.reset);

function fail(message) {
  say(`${C.red}ошибка:${C.reset} ${message}`);
  process.exitCode = 1;
}

// ---- approvals ---------------------------------------------------------------

function makeApprover(autoYes) {
  return async (request) => {
    if (autoYes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      if (request.kind === 'write') {
        say(`${C.accent}\nзапрос на запись файла${request.isNew ? ' (новый файл)' : ''}: ${C.reset}${request.path}`);
        if (request.diff.trim()) {
          for (const line of request.diff.split('\n')) {
            const color = line.startsWith('+') ? C.accent : line.startsWith('-') ? C.red : C.dim;
            say(color + '  ' + line + C.reset);
          }
        }
        answer = await new Promise(resolve => rl.question('применить? (y/N) ', resolve));
      } else {
        say(`${C.accent}\nзапрос на команду${C.reset} (таймаут ${Math.round(request.timeoutMs / 1000)} с, каталог ${request.cwd}):`);
        say('  ' + request.command);
        answer = await new Promise(resolve => rl.question('выполнить? (y/N) ', resolve));
      }
    } finally { rl.close(); }
    return /^y(es)?$/i.test(answer.trim());
  };
}

// ---- agent session -----------------------------------------------------------

async function ensureConfig(overrides) {
  const cfg = config.resolve(overrides);
  if (!cfg.baseUrl) { fail('Не задан адрес API. Выполните: notcode config set baseUrl https://api.openai.com/v1'); process.exit(1); }
  const bad = config.validateBaseUrl(cfg.baseUrl);
  if (bad) { fail('Некорректный baseUrl: ' + bad); process.exit(1); }
  if (!cfg.model) { fail('Не задана модель. Выполните: notcode config set model <имя> — список: notcode models'); process.exit(1); }
  if (!cfg.key) { fail('Нужен API-ключ: переменная NOTCODE_API_KEY или notcode config set key <ключ>'); process.exit(1); }
  return cfg;
}

async function runTaskStream(cfg, root, history, task, autoYes) {
  const approve = makeApprover(autoYes);
  const controller = new AbortController();
  const onSigInt = () => controller.abort(new Error('Прервано пользователем'));
  process.on('SIGINT', onSigInt);
  say('');
  try {
    const { answer, messages } = await require('../lib/agent').runAgent({
      config: cfg,
      root,
      history,
      task,
      approve,
      signal: controller.signal,
      onDelta: (text) => process.stdout.write(C.text + text + C.reset),
      onAction: ({ name, detail, done }) => {
        if (done) say(`${C.dim}  ✓ ${name}${detail ? ' · ' + detail : ''}${C.reset}`);
        else say(`${C.accent}▸ ${name}${detail ? ' ' + detail : ''}${C.reset}`);
      },
    });
    say('\n');
    return { answer, messages };
  } catch (error) {
    say('');
    fail(error.message || String(error));
    return null;
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}

async function chat(root, args) {
  const cfg = await ensureConfig(args);
  const autoYes = args.has('--yes');
  say(`${C.dim}NotCode CLI · проект: ${root}${C.reset}`);
  say(`${C.dim}Провайдер: ${cfg.baseUrl} · модель: ${cfg.model}${autoYes ? ' · --yes: подтверждения отключены' : ''}${C.reset}`);
  say(`${C.dim}/clear — сбросить диалог · /exit — выход${C.reset}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.accent}вы${C.reset} › ` });
  let history = [];
  rl.prompt();
  rl.on('line', (line) => {
    const task = line.trim();
    void (async () => {
      if (!task) { rl.prompt(); return; }
      if (task === '/exit' || task === '/quit') { rl.close(); return; }
      if (task === '/clear') { history = []; say(`${C.dim}диалог очищен${C.reset}\n`); rl.prompt(); return; }
      if (task.startsWith('/')) { say(`${C.dim}неизвестная команда. /clear, /exit${C.reset}\n`); rl.prompt(); return; }
      const result = await runTaskStream(cfg, root, history, task, autoYes);
      if (result) {
        history = result.messages.filter(m => m.role !== 'system');
        if (history.length > 60) history = history.slice(-60);
      }
      rl.prompt();
    })();
  }).on('close', () => { say(`${C.dim}пока!${C.reset}`); process.exit(0); });
}

async function runOnce(root, args) {
  const task = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (!task) { fail('Укажите задачу: notcode run "исправь тесты в src"'); return; }
  const cfg = await ensureConfig(args);
  const result = await runTaskStream(cfg, root, [], task, args.has('--yes'));
  process.exitCode = result ? 0 : 1;
}

async function models(args) {
  const cfg = await ensureConfig(args);
  const response = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } });
  if (!response.ok) { fail(`Провайдер вернул HTTP ${response.status}`); return; }
  const data = await response.json();
  const list = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
  say(`${C.text}Модели на ${cfg.baseUrl}:${C.reset}`);
  for (const id of list.slice(0, 50)) say('  ' + id);
  if (list.length > 50) say(`${C.dim}…и ещё ${list.length - 50}${C.reset}`);
  if (!list.length) say(`${C.dim}Провайдер не вернул список моделей — задайте модель вручную: notcode config set model <имя>${C.reset}`);
  else if (!list.includes(cfg.model)) say(`${C.red}Внимание:${C.reset} заданная модель «${cfg.model}» не входит в список.`);
}

function configCommand(args) {
  const [action, key, ...rest] = args;
  if (action === 'show') {
    const current = config.resolve();
    say(`${C.text}config.json:${C.reset} ${config.configPath()}`);
    say(`  baseUrl  ${current.baseUrl || `${C.red}не задан${C.reset}`}`);
    say(`  model    ${current.model || `${C.red}не задана${C.reset}`}`);
    say(`  key      ${current.key ? `${C.accent}задан${current.key.length} симв.${C.reset}` : `${C.red}не задан${C.reset} (NOTCODE_API_KEY или config set key)`}`);
    return;
  }
  if (action === 'set') {
    if (!['baseUrl', 'model', 'key'].includes(key)) { fail('Ключи: baseUrl, model, key'); return; }
    const value = rest.join(' ').trim();
    if (!value) { fail('Пустое значение'); return; }
    if (key === 'baseUrl') {
      const bad = config.validateBaseUrl(value);
      if (bad) { fail(bad); return; }
    }
    config.save({ [key]: value });
    say(`${C.accent}сохранено:${C.reset} ${key} = ${key === 'key' ? '***' : value}`);
    return;
  }
  say('Использование: notcode config show | notcode config set <baseUrl|model|key> <значение>');
}

// ---- dispatch ----------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') { root = path.resolve(argv[++i]); continue; }
    if (argv[i] === '--yes') { args.push('--yes'); continue; }
    args.push(argv[i]);
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`Папка проекта не найдена: ${root}`);
    process.exit(1);
  }

  const [command, ...rest] = args;
  if (!command || command === 'chat' || command === 'help') {
    if (command === 'help') {
      say('NotCode CLI — терминальный ИИ-агент.\n');
      say('  notcode [chat]            агент в текущей папке (интерактив)');
      say('  notcode run "задача"      одна задача от начала до конца');
      say('  notcode models            проверить подключение и модели');
      say('  notcode config show|set   настройки: baseUrl, model, key');
      say('  --dir <путь>              работать в другой папке');
      say('  --yes                     не спрашивать подтверждения (осторожно!)');
      return;
    }
    await chat(root, args);
    return;
  }
  if (command === 'run') return runOnce(root, rest);
  if (command === 'models') return models(args.filter(a => a !== 'models'));
  if (command === 'config') return configCommand(rest);
  fail(`Неизвестная команда: ${command}. Справка: notcode help`);
}

main().catch((error) => { fail(error.message || String(error)); });
void tools; void path;
