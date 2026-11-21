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
const mcp = require('../lib/mcp');
const local = require('../lib/local-models');

const VERSION = require('../package.json').version;

const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR;
const C = NO_COLOR ? { accent: '', dim: '', text: '', red: '', reset: '', bold: '' } : {
  accent: '\x1b[38;5;154m', dim: '\x1b[90m', text: '\x1b[97m', red: '\x1b[91m', reset: '\x1b[0m',
};
const say = (text = '') => process.stdout.write(text + '\n');
const fail = (message) => { say(`${C.red}ошибка:${C.reset} ${message}`); process.exitCode = 1; };
/// Показывает ошибку с подсказкой, если провайдер её приложил (hint из llm.js).
function failError(error) {
  fail(error?.message || String(error));
  if (error?.hint) say(`${C.accent}подсказка:${C.reset} ${error.hint}`);
}

const PROVIDER_PRESETS = [
  { label: 'OpenCode Zen', hint: 'бесплатные модели (big-pickle, DeepSeek Flash и др.)', value: 'https://opencode.ai/inference/openai/v1' },
  { label: 'OpenRouter', hint: 'сотни моделей, один ключ', value: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', hint: 'api.deepseek.com', value: 'https://api.deepseek.com/v1' },
  { label: 'Groq', hint: 'быстрый инференс', value: 'https://api.groq.com/openai/v1' },
  { label: 'OpenAI', hint: 'api.openai.com', value: 'https://api.openai.com/v1' },
  { label: 'Ollama · локально', hint: 'скачивание и запуск на твоём ПК, без ключа', value: 'http://127.0.0.1:11434/v1', noKey: true, local: true },
  { label: 'Свой адрес…', hint: 'любой OpenAI-compatible', value: '__custom__' },
];

// ---- provider/model setup ----------------------------------------------------

async function fetchModelList(cfg) {
  const response = await fetch(`${cfg.baseUrl}/models`, cfg.key ? { headers: { Authorization: `Bearer ${cfg.key}` } } : {});
  if (!response.ok) throw new Error(`Провайдер вернул HTTP ${response.status} на /models`);
  const data = await response.json();
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

/// Правка полученного списка: добавить свои имена, убрать лишние, сохранить.
/// Esc в меню «Готово» тоже сохраняет — отменить можно только до выбора модели.
async function editModelList(ids) {
  let list = [...ids];
  for (;;) {
    const items = [
      { label: `Готово — сохранить (${list.length} модел.)`, hint: 'переходим к выбору модели' },
      { label: 'Добавить модель вручную…', hint: 'имя из каталога провайдера или своё' },
      { label: 'Убрать модель из списка…', hint: 'почистить мусорные записи' },
    ];
    const index = await ui.pickMenu({ title: `Получено моделей: ${list.length}. Что изменить?`, items, pageSize: 8 });
    if (index === null || index === 0) return list;
    if (index === 1) {
      const added = await ui.promptLine('Имя модели (можно несколько через запятую)');
      if (added) for (const name of added.split(/[\s,]+/).map(v => v.trim()).filter(Boolean)) {
        if (!list.includes(name)) list.push(name);
      }
    } else if (list.length) {
      const removeIndex = await ui.pickMenu({ title: 'Какую модель убрать? (Esc — назад)', items: list.map(id => ({ label: id })), pageSize: 16 });
      if (removeIndex !== null) list.splice(removeIndex, 1);
    }
  }
}

async function setupWizard(current) {
  const cfg = { ...current };
  // 1. Провайдер: текущий остаётся по умолчанию, пресеты и свой адрес — рядом.
  // noKey для «Оставить текущий» не ставится: если ключ ещё не задан, вопрос
  // ключа показывается ПЕРЕД фетчем моделей (Enter пропускает).
  const presets = cfg.baseUrl
    ? [{ label: `Оставить текущий · ${cfg.baseUrl}`, hint: 'Enter', value: cfg.baseUrl }, ...PROVIDER_PRESETS]
    : PROVIDER_PRESETS;
  const presetIndex = await ui.pickMenu({ title: 'Выберите провайдера', items: presets, pageSize: 10 });
  if (presetIndex === null) return null;
  const preset = presets[presetIndex];
  cfg.baseUrl = preset.value === '__custom__'
    ? await ui.promptLine('Адрес API (например, https://my-gateway.example/v1)')
    : preset.value;
  if (!cfg.baseUrl) return null;
  const bad = config.validateBaseUrl(cfg.baseUrl);
  if (bad) { fail(bad); return null; }
  // Локальные модели: железо → рекомендации → скачивание → выбор.
  if (preset.local) {
    const localCfg = await localWizard();
    if (!localCfg) return null;
    return localCfg;
  }
  // 2. Ключ — опционален: локальным шлюзам не нужен, Enter пропускает.
  if (!preset.noKey && !cfg.key) {
    cfg.key = await ui.askSecret('API-ключ провайдера (Enter — пропустить, если ключ не нужен)');
  }
  // 3. Живой список моделей провайдера.
  say(`${C.dim}Получаю список моделей с ${cfg.baseUrl}…${C.reset}`);
  let ids = [];
  try { ids = await fetchModelList(cfg); } catch (error) { failError(error); }
  if (ids.length) {
    say(`${C.dim}Моделей у провайдера: ${ids.length}${C.reset}`);
    const edited = await editModelList(ids);
    if (!edited || !edited.length) return null;
    cfg.models = edited.join(',');
    const modelIndex = await ui.pickMenu({ title: 'Модель по умолчанию', items: edited.map(id => ({ label: id, hint: catalog.describe(id) })), pageSize: 16 });
    if (modelIndex === null) return null;
    cfg.model = edited[modelIndex];
  } else {
    say(`${C.dim}Список недоступен — введите модель вручную${C.reset}`);
    const manual = await ui.promptLine('Модель по умолчанию (например, gpt-4o-mini)');
    if (!manual) return null;
    cfg.model = manual;
    cfg.models = manual;
  }
  config.save(cfg);
  return config.resolve(cfg);
}

async function pickModelInteractive(cfg, title) {
  let ids = [];
  try { ids = await fetchModelList(cfg); } catch (error) {
    // Живой список недоступен — показываем сохранённый из мастера настройки.
    if (Array.isArray(cfg.models) && cfg.models.length) {
      say(`${C.dim}Живой список недоступен (${error.message}) — показываю сохранённый${C.reset}`);
      ids = cfg.models;
    } else { fail(error.message); return null; }
  }
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
  // Брендинг — до мастера настройки, чтобы он был виден и при первом запуске.
  ui.printBanner(`v${VERSION} · ваш ключ · ваши модели`);
  let cfg = await ensureConfig(args);
  const autoYes = args.includes('--yes');
  say(`${C.dim}  модель: ${C.reset}${C.accent}${cfg.model || 'не выбрана'}${C.reset}  ${C.dim}·  ${C.reset}${C.dim}провайдер: ${cfg.baseUrl}${C.reset}`);
  say(`  ${C.dim}/new /model /sessions /plan /queue /share /doctor /config /exit${C.reset}`);
  say('');

  // сессия: новая или продолжение
  let session = await pickSession();
  if (session === undefined) return; // Esc в меню
  if (session?.plan?.length) { say(''); for (const line of chatUi.planLines(session.plan)) say(line); say(''); }

  // MCP-серверы из конфига подключаем один раз на сессию (best effort).
  let mcpTools = [];
  const mcpConfigs = mcp.serverConfigs(config.load());
  if (mcpConfigs.length) {
    say(`${C.dim}MCP-серверы: ${mcpConfigs.map(c => c.name).join(', ')}…${C.reset}`);
    mcpTools = await mcp.collectMcpTools(mcpConfigs, warn => say(`${C.red}MCP:${C.reset} ${warn}`));
    say(`${C.dim}MCP-инструментов подключено: ${mcpTools.length}${C.reset}`);
  }
  const closeMcp = () => { for (const b of mcpTools) b.client.close(); };
  process.on('exit', closeMcp);

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

  // ---- очередь сообщений -------------------------------------------------------
  // Во время генерации введённый текст не теряется: попадает в очередь и
  // уходит агенту по мере освобождения. Выше в списке = раньше выполнится.
  const queue = [];        // [{text}]
  let busy = false;
  let currentAbort = null; // AbortController текущей генерации

  function printQueue() {
    if (!queue.length) { say(`${C.dim}очередь пуста${C.reset}`); return; }
    say(`${C.dim}очередь (первым выполнится верхний):${C.reset}`);
    queue.forEach((item, i) => say(`  ${i + 1}. ${item.text}`));
  }

  async function executeTask(task) {
    busy = true;
    try {
      const result = await runTaskStream(cfg, root, session, task, autoYes, mcpTools, queue, controller => { currentAbort = controller; });
      if (result) {
        session.id = session.id || `${Date.now()}-${sessions.slug(task)}`;
        session.name = session.name || task.slice(0, 60);
        session.model = cfg.model;
        session.messages = result.messages.filter(m => m.role !== 'system');
        if (result.plan?.length) session.plan = result.plan;
        sessions.save(session);
      }
    } finally { busy = false; currentAbort = null; }
  }

  async function pump() {
    if (busy || !queue.length) return;
    const next = queue.shift();
    await executeTask(next.text);
    await pump(); // следующий из очереди, если есть
  }

  async function shareChat() {
    const account = config.resolve();
    if (!account.accountUrl || !account.accountToken) { fail('Нужен аккаунт: notcode config set accountUrl <url> и accountToken <ncs_…>'); return; }
    if (!session?.messages?.length) { fail('Диалог пуст — делиться нечем.'); return; }
    try {
      const response = await fetch(`${account.accountUrl}/api/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.accountToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: session.name || 'Диалог NotCode',
          messages: session.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, text: m.content })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { fail(data.error || `HTTP ${response.status}`); return; }
      say(`${C.accent}публичная ссылка (90 дней):${C.reset} ${data.url}`);
    } catch (error) { failError(error); }
  }

  function queueCommand(restArgs) {
    const [action, indexRaw, ...direction] = restArgs;
    const index = Number.parseInt(indexRaw, 10) - 1;
    if (!action || action === 'list') { printQueue(); return; }
    if (action === 'rm') {
      if (!Number.isInteger(index) || !queue[index]) { fail('Укажите номер: /queue rm 1'); return; }
      queue.splice(index, 1);
      say(`${C.dim}удалено из очереди${C.reset}`);
      return;
    }
    if (action === 'mv') {
      const dir = direction.join(' ').trim();
      if (!Number.isInteger(index) || !queue[index] || !['up', 'down', 'вверх', 'вниз'].includes(dir)) {
        fail('Укажите: /queue mv 2 up (или down / вверх / вниз)');
        return;
      }
      const target = dir === 'up' || dir === 'вверх' ? index - 1 : index + 1;
      if (target < 0 || target >= queue.length) { fail('Переставлять некуда'); return; }
      [queue[index], queue[target]] = [queue[target], queue[index]];
      printQueue();
      return;
    }
    if (action === 'send') {
      // Принудительно: сообщение в начало очереди, текущая генерация прерывается.
      if (!Number.isInteger(index) || !queue[index]) { fail('Укажите номер: /queue send 1'); return; }
      if (!busy) { say(`${C.dim}агент свободен — очередь сама начнёт выполнение${C.reset}`); return; }
      const [item] = queue.splice(index, 1);
      queue.unshift(item);
      say(`${C.accent}принудительная отправка:${C.reset} ${item.text}`);
      currentAbort?.abort(new Error('Прервано: принудительная отправка из очереди'));
      return;
    }
    fail('Использование: /queue [list] · /queue mv N up|down · /queue rm N · /queue send N');
  }

  rl.on('line', (line) => {
    const task = line.trim();
    void (async () => {
      if (!task) { rl.prompt(); return; }
      if (task === '/exit' || task === '/quit') { currentAbort?.abort(new Error('Прервано пользователем')); rl.close(); return; }
      if (task === '/new') { session = { id: null, name: '', messages: [] }; say(`${C.dim}новый чат${C.reset}\n`); rl.prompt(); return; }
      if (task === '/sessions') { const next = await pickSession(); if (next !== undefined) session = next; rl.prompt(); return; }
      if (task === '/share') { await shareChat(); rl.prompt(); return; }
      if (task === '/doctor') { await doctor(); rl.prompt(); return; }
      if (task === '/plan') {
        if (session?.plan?.length) { for (const line of chatUi.planLines(session.plan)) say(line); }
        else say(`${C.dim}плана пока нет — агент сам создаст чеклист на многошаговой задаче${C.reset}`);
        rl.prompt(); return;
      }
      if (task === '/model') { await switchModel(); rl.prompt(); return; }
      if (task === '/config') { const next = await setupWizard(cfg); if (next) cfg = next; say(''); rl.prompt(); return; }
      if (task.startsWith('/queue')) { queueCommand(task.split(/\s+/).slice(1)); rl.prompt(); return; }
      if (task.startsWith('/')) { say(`${C.dim}команды: /new · /sessions · /model · /plan · /queue · /config · /exit${C.reset}\n`); rl.prompt(); return; }

      if (busy) {
        queue.push({ text: task });
        say(`${C.accent}⏳ в очереди (${queue.length}):${C.reset} ${task}`);
        say(`${C.dim}   изменить: /queue list · mv N up|down · rm N · send N — отправить принудительно${C.reset}`);
        rl.prompt();
        return;
      }
      await pumpStart(task);
      rl.prompt();
    })();
  }).on('close', () => { closeMcp(); say(`${C.dim}пока!${C.reset}`); process.exit(0); });

  async function pumpStart(firstTask) {
    queue.unshift({ text: firstTask });
    await pump();
  }
}

async function runTaskStream(cfg, root, session, task, autoYes, mcpTools = [], queue = [], registerController = () => {}) {
  const approve = makeApprover(autoYes);
  const controller = new AbortController();
  registerController(controller);
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

  function renderPlan(steps) {
    say('');
    for (const line of chatUi.planLines(steps)) say(line);
    say('');
  }

  try {
    const { answer, messages, plan, usage } = await require('../lib/agent').runAgent({
      config: cfg,
      root,
      history: session?.messages || [],
      task,
      approve,
      signal: controller.signal,
      mcpTools,
      onPlan: (steps) => { spinner.stop(); renderPlan(steps); spinner.start('работаю…'); },
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
        spinner.start(queue.length ? `работаю… · в очереди: ${queue.length}` : 'работаю…');
      },
      onToolOutput: (text) => {
        for (const line of text.split('\n')) toolOutputLines.push({ text: line, color: C.dim });
      },
    });
    spinner.stop();
    flushToolBlock();
    say('\n');
    say(chatUi.messageBubble('assistant', answer || '(пустой ответ)'));
    if (usage.total_tokens) {
      const mark = usage.estimated ? '≈' : '';
      say(`${C.dim}  ${mark}токены: ${usage.total_tokens} (запрос ${usage.prompt_tokens} · ответ ${usage.completion_tokens})${C.reset}`);
    }
    say('');
    return { answer, messages, plan, usage };
  } catch (error) {
    spinner.stop();
    flushToolBlock();
    say('');
    failError(error);
    return null;
  } finally {
    spinner.stop();
    process.removeListener('SIGINT', onSigInt);
  }
}

async function ensureConfig(overrides) {
  let cfg = config.resolve(overrides);
  // Ключ опционален: локальным шлюзам (Ollama) и открыим каталогам он не нужен.
  if (!cfg.baseUrl || !cfg.model) {
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
  ui.printBanner(`v${VERSION} · ваш ключ · ваши модели`);
  const cfg = await ensureConfig(args);
  const result = await runTaskStream(cfg, root, { messages: [] }, task, args.includes('--yes'));
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

// ---- MCP: управление серверами ---------------------------------------------------

function mcpCommand(args) {
  const [action, name, ...rest] = args;
  if (!action || action === 'list') {
    const servers = mcp.serverConfigs(config.load());
    if (!servers.length) { say(`${C.dim}MCP-серверов нет. Добавьте: notcode mcp add files -- node server.js${C.reset}`); return; }
    say(`${C.text}MCP-серверы (config.json → mcpServers):${C.reset}`);
    for (const s of servers) {
      say(`  ${C.accent}${s.name}${C.reset}  ${s.command} ${s.args.join(' ')}`);
    }
    say(`${C.dim}Инструменты подключатся автоматически при старте чата.${C.reset}`);
    return;
  }
  if (action === 'add') {
    if (!name) { fail('Укажите имя: notcode mcp add files -- node server.js'); return; }
    const sep = rest.indexOf('--');
    if (sep < 0) { fail('После имени укажите «--» и команду запуска сервера'); return; }
    const command = rest.slice(0, sep).join(' ').trim();
    const serverArgs = rest.slice(sep + 1).filter(a => a !== '--');
    if (!command) { fail('Пустая команда сервера'); return; }
    const current = config.load();
    const servers = { ...(current.mcpServers || {}), [name]: { command, ...(serverArgs.length ? { args: serverArgs } : {}) } };
    config.save({ mcpServers: servers });
    say(`${C.accent}добавлено:${C.reset} ${name} → ${command} ${serverArgs.join(' ')}`);
    return;
  }
  if (action === 'remove') {
    if (!name) { fail('Укажите имя сервера: notcode mcp remove files'); return; }
    const current = config.load();
    if (!current.mcpServers?.[name]) { fail(`Сервер «${name}» не найден`); return; }
    const servers = { ...current.mcpServers };
    delete servers[name];
    config.save({ mcpServers: servers });
    say(`${C.accent}удалено:${C.reset} ${name}`);
    return;
  }
  say('Использование: notcode mcp list | notcode mcp add <имя> -- <команда> [аргументы] | notcode mcp remove <имя>');
}

// ---- diagnostics -------------------------------------------------------------------

async function doctor() {
  const cfg = config.resolve();
  say(`${C.bold}notcode doctor${C.reset}`);
  say(`  версия CLI        ${C.accent}${VERSION}${C.reset}`);
  say(`  baseUrl           ${cfg.baseUrl || `${C.red}не задан${C.reset}`}`);
  say(`  модель            ${cfg.model || `${C.red}не задана${C.reset}`}`);
  say(`  ключ              ${cfg.key ? `${C.accent}задан${C.reset}` : `${C.dim}не задан (ок для локальных шлюзов)${C.reset}`}`);
  say(`  сохранённых модел. ${cfg.models.length}`);
  say(`  аккаунт           ${cfg.accountUrl ? cfg.accountUrl : `${C.dim}не привязан${C.reset}`}`);
  try {
    const started = Date.now();
    const response = await fetch(`${cfg.baseUrl}/models`, cfg.key ? { headers: { Authorization: `Bearer ${cfg.key}` } } : {});
    say(`  /models           ${response.ok ? `${C.accent}HTTP ${response.status}${C.reset} · ${Date.now() - started} мс` : `${C.red}HTTP ${response.status}${C.reset}`}`);
  } catch (error) {
    say(`  /models           ${C.red}недоступен · ${error.message}${C.reset}`);
  }
  const servers = require('../lib/mcp').serverConfigs(config.load());
  say(`  MCP-серверы       ${servers.length ? servers.map(s => s.name).join(', ') : `${C.dim}нет${C.reset}`}`);
  say(`  конфиг            ${config.configPath()}`);
}

// ---- локальные модели ---------------------------------------------------------

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

/// Менеджер локальных моделей: железо → рекомендации → скачивание → конфиг.
async function localWizard() {
  say(`${C.bold}Локальные модели · Ollama${C.reset}`);
  const hardware = await local.detectHardware();
  const gpuText = hardware.gpu
    ? `${hardware.gpu}${hardware.vramGb ? ` · VRAM ${hardware.vramGb} ГБ` : ''}`
    : 'не определена — рекомендации по RAM';
  say(`  CPU: ${hardware.cpu}`);
  say(`  RAM: ${hardware.ramGb} ГБ`);
  say(`  GPU: ${gpuText}`);

  const ollama = await local.findOllama();
  if (!ollama) {
    say(`${C.accent}Ollama не установлена.${C.reset}`);
    const choice = await ui.pickMenu({ title: 'Установить Ollama?', items: [
      { label: 'Установить через winget', hint: 'Windows 10/11, без вопросов' },
      { label: 'Открыть https://ollama.com/download', hint: 'установщик вручную' },
      { label: 'Отмена', hint: 'настроить облачного провайдера' },
    ], pageSize: 6 });
    if (choice === 0) {
      const run = require('node:child_process').spawnSync('cmd.exe', ['/c', 'winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements'], { stdio: 'inherit', timeout: 15 * 60 * 1000 });
      if (run.status !== 0) {
        fail('winget не смог установить Ollama — скачай вручную с https://ollama.com/download и перезапусти notcode');
        return null;
      }
      say(`${C.accent}Ollama установлена.${C.reset} Если команда не видна — открой новый терминал и повтори.`);
      const again = await local.findOllama();
      if (!again) { fail('ollama не найдена в PATH. Открой новый терминал и повтори: notcode local'); return null; }
      return await localWizard();
    }
    if (choice === 1) {
      const opener = process.platform === 'win32' ? 'cmd /c start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      require('node:child_process').exec(`${opener} "https://ollama.com/download"`);
      say('После установки перезапусти notcode.');
      return null;
    }
    return null;
  }

  try {
    const serveState = await local.ensureServe(ollama);
    if (serveState.started) say(`${C.dim}Сервер Ollama запущен в фоне (127.0.0.1:11434)${C.reset}`);
  } catch (error) {
    failError(error);
    return null;
  }

  const installed = await local.installedModels();
  if (installed.length) say(`${C.dim}Установлено: ${installed.join(', ')}${C.reset}`);

  const view = await ui.pickMenu({ title: 'Какие модели показать?', items: [
    { label: 'Рекомендуемые для твоего ПК', hint: 'влезают в RAM/GPU' },
    { label: 'Весь каталог (включая тяжёлые)', hint: 'тяжёлые запустятся медленно' },
    { label: 'Установленные', hint: 'уже скачаны' },
  ], pageSize: 8 });
  if (view === null) return null;

  let items;
  const recommendations = local.recommend(hardware, local.LOCAL_CATALOG, installed);
  if (view === 2) {
    if (!installed.length) { fail('Установленных моделей нет — сначала скачай из каталога.'); return null; }
    items = installed.map((name) => ({ label: name, hint: 'установлена' }));
  } else {
    const list = view === 0 ? recommendations.recommended : [...recommendations.recommended, ...recommendations.beyond];
    if (!list.length) { fail('Ничего не подошло — открой «Весь каталог».'); return null; }
    items = list.map((m) => ({
      label: m.name,
      hint: `${m.installed ? 'установлена · ' : ''}~${m.ramGb} ГБ${m.coding ? ' · код' : ''} · ${m.note}`,
    }));
  }
  const modelIndex = await ui.pickMenu({ title: 'Модель', items, pageSize: 14 });
  if (modelIndex === null) return null;
  const chosen = items[modelIndex].label;

  if (!installed.includes(chosen)) {
    say(`${C.dim}Скачиваю ${chosen} — файлы уйдут в домашнюю папку Ollama${C.reset}`);
    if (process.stdout.isTTY) process.stdout.write('\n');
    let lastRender = 0;
    try {
      await local.pullModel(ollama, chosen, (progress) => {
        if (progress.fraction === undefined) return;
        const now = Date.now();
        if (now - lastRender < 250 && progress.fraction < 1) return;
        lastRender = now;
        const percent = Math.round(progress.fraction * 100);
        const bars = Math.round(progress.fraction * 24);
        const line = `${C.accent}[${'='.repeat(bars)}${' '.repeat(24 - bars)}]${C.reset} ${percent}%  ${C.dim}${formatBytes(progress.doneBytes ?? 0)} / ${formatBytes(progress.totalBytes ?? 0)}${C.reset}`;
        if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
        else say(line);
        if (progress.fraction >= 1 && process.stdout.isTTY) process.stdout.write('\n');
      });
      say(`${C.accent}Скачано:${C.reset} ${chosen}`);
    } catch (error) {
      if (process.stdout.isTTY) process.stdout.write('\n');
      failError(error);
      return null;
    }
  }

  const saved = { baseUrl: local.OLLAMA_URL + local.OPENAI_PATH, key: '', model: chosen, models: [chosen] };
  config.save(saved);
  say(`${C.accent}Готово:${C.reset} ${chosen} работает локально — без интернета и без ключа.`);
  return config.resolve(saved);
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
    ui.printBanner(`v${VERSION} · ваш ключ · ваши модели`);
    say('  notcode                  интерактивная сессия (меню чатов и моделей)');
    say('  notcode run "задача"     одна задача от начала до конца');
    say('  notcode models           список моделей провайдера');
    say('  notcode local            локальные модели: железо → рекомендации → скачивание');
    say('  notcode mcp list         MCP-серверы (add <имя> -- <команда> / remove)');
    say('  notcode sync push|pull   чаты и провайдер ↔ аккаунт (--with-key)');
    say('  notcode google connect|status|backup — Google Drive');
    say('  notcode version          версия CLI');
    say('  notcode config           мастер настройки (show / set — по-старому)');
    say('  --dir <путь>             работать в другой папке');
    say('  --yes                    отключить подтверждения (осторожно!)');
    say('');
    say(`${C.dim}  в чате: /new /sessions /model /config /queue /exit · сообщения во время работы агента попадают в очередь (/queue send N — принудительно)${C.reset}`);
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
  if (command === 'mcp') return mcpCommand(rest);
  if (command === 'version' || command === '--version' || command === '-v') { say(`notcode-cli v${VERSION}`); return; }
  if (command === 'doctor') return doctor();
  if (command === 'local') return localWizard();
  fail(`Неизвестная команда: ${command}. Справка: notcode help`);
}

if (require.main === module) {
  main().catch((error) => { failError(error); });
}

// Внутренние функции — для эмуляционных тестов (test/wizard.test.js).
module.exports = { main, __internals: { setupWizard, chatLoop, runTaskStream, ensureConfig } };
