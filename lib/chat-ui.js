'use strict';
// Терминальный чат-UI: пузыри сообщений, разворачиваемые блоки инструментов,
// спиннер, статусная строка. Без зависимостей — чистые ANSI-коды.

const C = process.stdout.isTTY && !process.env.NO_COLOR ? {
  accent: '\x1b[38;5;154m', dim: '\x1b[90m', text: '\x1b[97m',
  red: '\x1b[91m', reset: '\x1b[0m', bold: '\x1b[1m',
  bgAccent: '\x1b[48;5;154m', bgDark: '\x1b[48;5;234m',
  cyan: '\x1b[96m', green: '\x1b[92m', yellow: '\x1b[93m',
} : { accent: '', dim: '', text: '', red: '', reset: '', bold: '', bgAccent: '', bgDark: '', cyan: '', green: '', yellow: '' };

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// Спиннер: рисует вращающийся индикатор в текущей строке.
class Spinner {
  constructor(label = '') {
    this.frame = 0;
    this.label = label;
    this.timer = null;
    this.active = false;
  }
  start(label) {
    if (label) this.label = label;
    if (!process.stdout.isTTY || process.env.NO_COLOR) return;
    this.active = true;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      const icon = C.accent + SPINNER_FRAMES[this.frame] + C.reset;
      process.stdout.write(`\r${icon} ${C.dim}${this.label}${C.reset}\x1b[K`);
    }, 80);
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.active) { process.stdout.write('\r\x1b[K'); this.active = false; }
  }
  update(label) { this.label = label; }
}

/// Разворачиваемый блок инструмента: свёрнуто — одна строка,
/// развернуто — полный вывод. Переключается по нажатию 'e'.
class CollapsibleBlock {
  constructor(lines) {
    this.lines = lines;    // [{text, color}]
    this.expanded = false;
    this.rendered = 0;
  }
  render() {
    const out = [];
    const visible = this.expanded ? this.lines : this.lines.slice(0, 2);
    for (const { text, color } of visible) {
      out.push((color || '') + text + C.reset);
    }
    if (!this.expanded && this.lines.length > 2) {
      out.push(C.dim + `  … ещё ${this.lines.length - 2} строк (e — развернуть)` + C.reset);
    }
    return out;
  }
}

/// Пузырь сообщения: роль + контент в цветном блоке.
function messageBubble(role, content, maxWidth = 100) {
  const isUser = role === 'user';
  const label = isUser ? `${C.bold}вы${C.reset}` : `${C.accent}${C.bold}агент${C.reset}`;
  const border = isUser ? C.dim : C.dim;
  const lines = [];
  lines.push(`${border}  ┌─ ${label} ${'─'.repeat(Math.max(3, maxWidth - 8 - role.length))}`);
  for (const line of content.split('\n')) {
    // Перенос длинных строк
    let remaining = line;
    while (remaining.length > maxWidth) {
      let cut = remaining.lastIndexOf(' ', maxWidth);
      if (cut < maxWidth * 0.5) cut = maxWidth;
      lines.push(`${border}  │ ${remaining.slice(0, cut)}`);
      remaining = remaining.slice(cut + 1);
    }
    if (remaining) lines.push(`${border}  │ ${remaining}`);
  }
  lines.push(`${border}  └${'─'.repeat(Math.max(3, maxWidth - 4))}`);
  return lines.join('\n');
}

/// Заголовок инструмента: ▸ имя · детали (или ✓ при завершении).
function toolLine(name, detail, done) {
  const icon = done ? `${C.green}✓${C.reset}` : `${C.accent}▸${C.reset}`;
  const d = detail ? ` ${C.dim}${detail}${C.reset}` : '';
  return `  ${icon} ${C.text}${name}${C.reset}${d}`;
}

/// Отступ для вывода инструмента.
function toolOutput(text) {
  return text.split('\n').map(l => `  ${C.dim}  │ ${l}${C.reset}`).join('\n');
}

/// Чеклист плана: ✓ готово, ▶ в работе, точка — ожидает.
function planLines(steps, maxWidth = 72) {
  const out = [`${C.bold}План${C.reset}`];
  const mark = { done: `${C.green}✓${C.reset}`, in_progress: `${C.accent}▶${C.reset}`, pending: `${C.dim}·${C.reset}` };
  steps.forEach((step, i) => {
    let title = step.title;
    if (title.length > maxWidth) title = title.slice(0, maxWidth - 1) + '…';
    const dim = step.status === 'done';
    const text = dim ? C.dim + title + C.reset : C.text + title + C.reset;
    out.push(`  ${mark[step.status] || mark.pending} ${i + 1}. ${text}`);
  });
  return out;
}

module.exports = { C, Spinner, CollapsibleBlock, messageBubble, toolLine, toolOutput, planLines, SPINNER_FRAMES };
