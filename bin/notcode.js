#!/usr/bin/env node
'use strict';
// NotCode CLI entry point — frameless TUI without dependencies.
//   notcode                интерактивная сессия (баннер → чаты → диалог)
//   notcode run "задача"   одна задача от начала до конца
//   notcode models         список моделей провайдера
//   notcode config         мастер настройки (или config show / set k v)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const config = require('../lib/config');
const sessions = require('../lib/sessions');
const ui = require('../lib/ui-menu');
const catalog = require('../lib/model-catalog');
const chatUi = require('../lib/chat-ui');

const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR;
const C = NO_COLOR ? { accent: '', dim: '', text: '', red: '', reset: '' } : {
  accent: '\x1b[38;5;154m', dim: '\x1b[90m', text: '\x1b[97m', red: '\x1b[91m', reset: '\x1b[0m',
};
const say = (text = '') => process.stdout.write(text + '\n');
const fail = (message) => { say(`${C.red}ошибка:${C.reset} ${message}`); process.exitCode = 1; };

const PROVIDER_PRESETS = [
  { label: 'OpenRouter', hint: 'сотни моделей, один ключ', value: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', hint: 'api.deepseek.com', value: 'https://api.deepseek.com/v1' },
  { label: 'Groq', hint: 'быстрый инференс', value: 'https://api.groq.com/openai/v1' },
  { label: 'OpenAI', hint: 'api.openai.com', value: 'https://api.openai.com/v1' },
  { label: 'Ollama · локально', hint: '127.0.0.1:11434', value: 'http://127.0.0.1:11434/v1' },
  { label: 'Свой адрес…', hint: 'любой OpenAI-compatible', value: '__custom__' },
];

// ---- provider/model setup ----------------------------------------------------

async function fetchModelList(cfg) {
  const response = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } });
  if (!response.ok) throw new Error(`Провайдер вернул HTTP ${response.status} на /models`);
  const data = await response.json();
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

async function setupWizard(current) {
  let cfg = { ...current };
  if (!cfg.baseUrl) {
    const index = await ui.pickMenu({ title: 'Выберите провайдера', items: PROVIDER_PRESETS });
    if (index === null) return null;
    const preset = PROVIDER_PRESETS[index];
    cfg.baseUrl = preset.value === '__custom__'
      ? await ui.promptLine('Адрес API (например, https://my-gateway.example/v1)')
      : preset.value;
    if (!cfg.baseUrl) return null;
    const bad = config.validateBaseUrl(cfg.baseUrl);
    if (bad) { fail(bad); return null; }
  }
  if (!cfg.key) {
    cfg.key = await ui.askSecret('API-ключ провайдера');
    if (!cfg.key) { fail('Без ключа агент не сможет отвечать.'); return null; }
  }
  if (!cfg.model) {
    const chosen = await pickModelInteractive(cfg, 'Выберите модель');
    if (!chosen) return null;
    cfg.model = chosen;
  }
  config.save(cfg);
  return config.resolve(cfg);
}

async function pickModelInteractive(cfg, title) {
  let ids = [];
  try { ids = await fetchModelList(cfg); } catch (error) { fail(error.message); return null; }
  if (!ids.length) return ui.promptLine('Провайдер не отдал список моделей — введите имя модели вручную');
  say(`${C.dim}Моделей у провайдера: ${ids.length}${C.reset}`);
  // Сортируем: сначала известные (каталог), потом остальные. Free — в начало.
  const items = ids.map(id => {
    const meta = catalog.lookup(id);
    const isFree = meta?.free || id.includes(':free');
    return { label: id, hint: catalog.describe(id), priority: meta ? (isFree ? 0 : 1) : 2, free: isFree };
  }).sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
  const index = await ui.pickMenu({ title, items, pageSize: 16 });
  if (index === null) return null;
  return ids.length > items.length ? items[index] ? items[index].label : null : ids[index];
}

// ---- approvals ----------------------------------------------------------------

function makeApprover(autoYes) {
  return async (request) => {
    if (autoYes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      if (request.kind === 'write') {
        say(`${C.accent}\nзапись файла${request.isNew ? ' (новый файл)' : ''}: ${C.reset}${request.path}`);
        for (const line of request.diff.split('\n')) {
          const color = line.startsWith('+') ? C.accent : line.startsWith('-') ? C.red : C.dim;
          say(color + '  ' + line + C.reset);
        }
        answer = await new Promise(resolve => rl.question('применить? (y/N) ', resolve));
      } else {
        say(`${C.accent}\nкоманда${C.reset} (таймаут ${Math.round(request.timeoutMs / 1000)} с, каталог ${request.cwd}):`);
        say('  ' + request.command);
        answer = await new Promise(resolve => rl.question('выполнить? (y/N) ', resolve));
      }
    } finally { rl.close(); }
    return /^y(es)?$/i.test(answer.trim());
  };
}

// ---- chat ---------------------------------------------------------------------

async function chatLoop(root, args) {
  let cfg = await ensureConfig(args);
  const autoYes = args.has('--yes');
  ui.printBanner('v0.4.0 · ваш ключ · ваши модели');
  say(`${C.dim}  ${{ }.toString.call(async () => 0).slice(8, -1) === 'Function' ? '' : ''}модель: ${C.reset}${C.accent}${cfg.model || 'не выбрана'}${C.reset}  ${C.dim}·  ${C.reset}${C.dim}провайдер: ${cfg.baseUrl}${C.reset}`);
  say(`  ${C.dim}/new /model /sessions /search /config /exit${C.reset}`);
  say('');

  // сессия: новая или продолжение
  let session = await pickSession();
  if (session === undefined) return; // Esc в меню

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.accent}вы › ${C.reset}` });

  async function pickSession() {
    const saved = sessions.list();
    const items = [
      { label: 'Новый чат', hint: 'начать с чистого листа' },
      ...saved.slice(0, 12).map(s => ({ label: s.name, hint: `${s.model || ''} · ${new Date(s.updatedAt).toLocaleString('ru-RU')}`.trim() })),
    ];
    const index = await ui.pickMenu({ title: 'Чаты', items });
    if (index === null) return undefined;
    if (index === 0) return { id: null, name: '', messages: [] };
    const loaded = sessions.load(saved[index - 1].id);
    cfg.model = loaded.model || cfg.model;
    return { id: loaded.id, name: loaded.name, messages: (loaded.messages || []).filter(m => m.role !== 'system') };
  }

  async function switchModel() {
    const chosen = await pickModelInteractive(cfg, 'Сменить модель');
    if (chosen) {
      cfg.model = chosen;
      config.save({ model: chosen });
      if (session) { session.model = chosen; sessions.save(session); }
      say(`${C.accent}модель:${C.reset} ${chosen}`);
    }
  }

  rl.on('SIGINT', () => { say(''); rl.prompt(); });
  rl.prompt();
  rl.on('line', (line) => {
    const task = line.trim();
    void (async () => {
      if (!task) { rl.prompt(); return; }
      if (task === '/exit' || task === '/quit') { rl.close(); return; }
      if (task === '/new') { session = { id: null, name: '', messages: [] }; say(`${C.dim}новый чат${C.reset}\n`); rl.prompt(); return; }
      if (task === '/sessions') { const next = await pickSession(); if (next !== undefined) session = next; rl.prompt(); return; }
      if (task === '/model') { await switchModel(); rl.prompt(); return; }
      if (task === '/config') { const next = await setupWizard(cfg); if (next) cfg = next; say(''); rl.prompt(); return; }
      if (task.startsWith('/')) { say(`${C.dim}команды: /new · /sessions · /model · /config · /exit${C.reset}\n`); rl.prompt(); return; }

      const result = await runTaskStream(cfg, root, session, task, autoYes);
      if (result) {
        session.id = session.id || `${Date.now()}-${sessions.slug(task)}`;
        session.name = session.name || task.slice(0, 60);
        session.model = cfg.model;
        session.messages = result.messages.filter(m => m.role !== 'system');
        sessions.save(session);
      }
      rl.prompt();
    })();
  }).on('close', () => { say(`${C.dim}пока!${C.reset}`); process.exit(0); });
}

async function runTaskStream(cfg, root, session, task, autoYes) {
  const approve = makeApprover(autoYes);
  const controller = new AbortController();
  const onSigInt = () => controller.abort(new Error('Прервано пользователем'));
  process.on('SIGINT', onSigInt);
  say('');
  const spinner = new chatUi.Spinner('думаю…');
  let toolOutputLines = [];

  function flushToolBlock() {
    if (toolOutputLines.length) {
      const block = new chatUi.CollapsibleBlock(toolOutputLines);
      for (const line of block.render()) say(line);
      toolOutputLines = [];
    }
  }

  try {
    const { answer, messages } = await require('../lib/agent').runAgent({
      config: cfg,
      root,
      history: session?.messages || [],
      task,
      approve,
      signal: controller.signal,
      onDelta: (text) => { spinner.stop(); process.stdout.write(C.text + text + C.reset); },
      onAction: ({ name, detail, done }) => {
        spinner.stop();
        if (done) {
          flushToolBlock();
          say(chatUi.toolLine(name, detail, true));
        } else {
          flushToolBlock();
          say(chatUi.toolLine(name, detail, false));
          if (name === 'run_command' || name === 'write_file') spinner.update(name === 'run_command' ? 'выполняю…' : 'записываю…');
        }
        spinner.start('работаю…');
      },
      onToolOutput: (text) => {
        for (const line of text.split('\n')) toolOutputLines.push({ text: line, color: C.dim });
      },
    });
    spinner.stop();
    flushToolBlock();
    say('\n');
    say(chatUi.messageBubble('assistant', answer || '(пустой ответ)'));
    say('');
    return { answer, messages };
  } catch (error) {
    spinner.stop();
    flushToolBlock();
    say('');
    fail(error.message || String(error));
    return null;
  } finally {
    spinner.stop();
    process.removeListener('SIGINT', onSigInt);
  }
}

async function ensureConfig(overrides) {
  let cfg = config.resolve(overrides);
  if (!cfg.baseUrl || !cfg.key || !cfg.model) {
    say(`${C.dim}первый запуск — настройка провайдера${C.reset}\n`);
    const setup = await setupWizard(cfg);
    if (!setup) process.exit(1);
    cfg = setup;
    say('');
  }
  const bad = config.validateBaseUrl(cfg.baseUrl);
  if (bad) { fail('Некорректный baseUrl: ' + bad); process.exit(1); }
  return cfg;
}

// ---- commands ------------------------------------------------------------------

async function runOnce(root, args) {
  const task = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (!task) { fail('Укажите задачу: notcode run "исправь тесты в src"'); return; }
  const cfg = await ensureConfig(args);
  const result = await runTaskStream(cfg, root, { messages: [] }, task, args.has('--yes'));
  process.exitCode = result ? 0 : 1;
}

async function models(args) {
  const cfg = await ensureConfig(args);
  const list = await fetchModelList(cfg);
  say(`${C.text}Модели на ${cfg.baseUrl}:${C.reset}`);
  for (const id of list.slice(0, 50)) say('  ' + id);
  if (list.length > 50) say(`${C.dim}…и ещё ${list.length - 50}${C.reset}`);
  if (!list.length) say(`${C.dim}Список пуст — задайте модель вручную: notcode config set model <имя>${C.reset}`);
  else if (!list.includes(cfg.model)) say(`${C.red}Внимание:${C.reset} заданная модель «${cfg.model}» не входит в список.`);
}

async function configCommand(args) {
  const [action, key, ...rest] = args;
  if (!action || action === 'wizard') {
    const next = await setupWizard(config.resolve());
    if (next) say(`${C.accent}готово${C.reset}: ${next.baseUrl} · ${next.model}`);
    return;
  }
  if (action === 'show') {
    const current = config.resolve();
    say(`${C.text}config.json:${C.reset} ${config.configPath()}`);
    say(`  baseUrl        ${current.baseUrl || `${C.red}не задан${C.reset}`}`);
    say(`  model          ${current.model || `${C.red}не задана${C.reset}`}`);
    say(`  key            ${current.key ? `${C.accent}задан (${current.key.length} симв.)${C.reset}` : `${C.red}не задан${C.reset}`}`);
    say(`  accountUrl     ${current.accountUrl || `${C.dim}не задан${C.reset}`}`);
    say(`  accountToken   ${current.accountToken ? `${C.accent}задан${C.reset}` : `${C.dim}не задан${C.reset}`}`);
    return;
  }
  if (action === 'set') {
    if (!['baseUrl', 'model', 'key', 'accountUrl', 'accountToken', 'syncKey'].includes(key)) {
      fail('Ключи: baseUrl, model, key, accountUrl, accountToken, syncKey');
      return;
    }
    const value = rest.join(' ').trim();
    if (!value) { fail('Пустое значение'); return; }
    if (key === 'accountToken' && !/^ncs_[A-Za-z0-9_-]+$/.test(value)) {
      fail('accountToken — это токен сессии вида ncs_…');
      return;
    }
    if (key === 'baseUrl') {
      const bad = config.validateBaseUrl(value);
      if (bad) { fail(bad); return; }
    }
    config.save({ [key]: value });
    say(`${C.accent}сохранено:${C.reset} ${key} = ${key === 'key' ? '***' : value}`);
    return;
  }
  say('Использование: notcode config | notcode config show | notcode config set <baseUrl|model|key> <значение>');
}

// ---- dispatch --------------------------------------------------------------------

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
  if (!command || command === 'chat') return chatLoop(root, args);
  if (command === 'help' || command === '--help' || command === '-h') {
    ui.printBanner('v0.2.0 · ваш ключ · ваши модели');
    say('  notcode                  интерактивная сессия (меню чатов и моделей)');
    say('  notcode run "задача"     одна задача от начала до конца');
    say('  notcode models           список моделей провайдера');
    say('  notcode sync push|pull   чаты и провайдер ↔ аккаунт (--with-key)');
    say('  notcode google connect|status|backup — Google Drive');
    say('  notcode config           мастер настройки (show / set — по-старому)');
    say('  --dir <путь>             работать в другой папке');
    say('  --yes                    отключить подтверждения (осторожно!)');
    return;
  }
  if (command === 'run') return runOnce(root, rest);
  if (command === 'google') {
    const [action] = rest;
    const account = { accountUrl: config.resolve().accountUrl, accountToken: config.resolve().accountToken };
    if (!account.accountUrl || !account.accountToken) { fail('Нужен аккаунт: notcode config set accountUrl/accountToken'); return; }
    const api = (method, path2, body) => fetch(account.accountUrl + path2, {
      method,
      headers: { Authorization: `Bearer ${account.accountToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(r => r.json().catch(() => ({})));
    if (action === 'connect') {
      const url2 = `${account.accountUrl}/auth/google?token=${encodeURIComponent(account.accountToken)}`;
      const opener = process.platform === 'win32' ? 'cmd /c start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      require('node:child_process').exec(`${opener} "${url2.replace(/&/g, '^&')}"`);
      say('Открываю браузер для привязки Google Drive…');
      return;
    }
    if (action === 'status') {
      const st = await api('GET', '/api/google/status');
      say(st.connected ? `Google Drive привязан: ${st.email}` : 'Google Drive не привязан.');
      return;
    }
    if (action === 'backup') {
      const sessionsDir = path.join(os.homedir(), '.notcode', 'sessions');
      const chats = [];
      for (const file of fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          chats.push({ id: data.id, title: data.name, model: data.model, messages: data.messages || [] });
        } catch { /* skip */ }
      }
      const payload = JSON.stringify({ source: 'cli', exportedAt: Date.now(), chats });
      const response = await fetch(`${account.accountUrl}/api/drive/backup?name=cli`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${account.accountToken}`, 'Content-Type': 'application/json' },
        body: payload,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { fail(data.error || `HTTP ${response.status}`); return; }
      say(`Бэкап сохранён в Google Drive: ${data.bytes} байт, чатов ${chats.length}.`);
      return;
    }
    say('Использование: notcode google connect|status|backup');
    return;
  }
  if (command === 'sync') {
    const direction = rest.find(a => a === 'push' || a === 'pull');
    if (!direction) { fail('Использование: notcode sync push|pull [--with-key]'); return; }
    const sync = require('../lib/sync');
    if (direction === 'push') await sync.push(config, root, rest.includes('--with-key'));
    else await sync.pull(config, root, rest.includes('--with-key'));
    return;
  }
  if (command === 'models') return models(args.filter(a => a !== 'models'));
  if (command === 'config') return configCommand(rest);
  fail(`Неизвестная команда: ${command}. Справка: notcode help`);
}

main().catch((error) => { fail(error.message || String(error)); });
