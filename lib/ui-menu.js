'use strict';
// Zero-dependency terminal UI: box menus with arrow keys, a banner, secret
// input. Interactive only when stdin is a TTY; everywhere else (tests, pipes)
// renderStatic() gives the same picture as plain lines.

const readline = require('node:readline');

const C = process.stdout.isTTY && !process.env.NO_COLOR ? {
  accent: '\x1b[38;5;154m', dim: '\x1b[90m', text: '\x1b[97m',
  red: '\x1b[91m', reset: '\x1b[0m', bold: '\x1b[1m',
} : { accent: '', dim: '', text: '', red: '', reset: '', bold: '' };

// ---- banner -----------------------------------------------------------------

const GLYPHS = {
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  C: ['  ██████╗', ' ██╔════╝', ' ██║     ', ' ██║     ', ' ╚██████╗', '  ╚═════╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  '.': ['   ', '   ', '   ', '   ', '   ', '██╗'],
};

function banner(text = 'NOTCODE') {
  const rows = ['', '', '', '', '', ''].map(() => []);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] || GLYPHS['.'];
    glyph.forEach((line, i) => rows[i].push(line));
  }
  return rows.map(r => r.join(' ')).join('\n');
}

function printBanner(subtitle = '') {
  process.stdout.write(C.accent + banner() + C.reset + '\n');
  if (subtitle) process.stdout.write(C.dim + '  ' + subtitle + C.reset + '\n\n');
}

// ---- static render (pure, for tests and pipes) -------------------------------

function renderMenu(title, items, activeIndex, viewport = 12, pageStart = 0) {
  const lines = [];
  const frame = (text) => `  │ ${text}`;
  lines.push(C.dim + '  ╭' + '─'.repeat(Math.max(title.length + 6, 40)) + '╮' + C.reset);
  lines.push(frame(C.bold + title + C.reset));
  lines.push('  │');
  const visible = items.slice(pageStart, pageStart + viewport);
  visible.forEach((item, i) => {
    const index = pageStart + i;
    const selected = index === activeIndex;
    const marker = selected ? C.accent + '▸ ' : '  ';
    const color = selected ? C.accent : item.danger ? C.red : C.text;
    const hint = item.hint ? C.dim + '  ' + item.hint + C.reset : '';
    lines.push(frame(marker + color + item.label + C.reset + hint));
  });
  if (items.length > viewport) {
    lines.push(frame(C.dim + `  ↑↓ · ${Math.min(pageStart + viewport, items.length)}/${items.length}${pageStart > 0 ? ' · ещё выше' : ''}${pageStart + viewport < items.length ? ' · ниже' : ''}` + C.reset));
  }
  lines.push('  ╰' + '─'.repeat(Math.max(title.length + 6, 40)) + '╯' + C.reset);
  lines.push(C.dim + '  ↑/↓ — выбрать · Enter — ок · Esc — назад' + C.reset);
  return lines;
}

/// Interactive menu. Returns the chosen index or null on Esc.
function pickMenu({ title, items, initialIndex = 0, pageSize = 12 }) {
  if (!process.stdin.isTTY || process.env.NOTCODE_MENU_STATIC) {
    const lines = renderMenu(title, items, initialIndex, pageSize, 0);
    process.stdout.write(lines.join('\n') + '\n');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let active = Math.max(0, Math.min(initialIndex, items.length - 1));
    let pageStart = Math.max(0, active - (pageSize - 1));
    let drawn = 0;
    const out = process.stdout;
    if (process.stdout.isTTY) out.write('\x1b[?25l'); // hide cursor

    function draw() {
      const lines = renderMenu(title, items, active, pageSize, pageStart);
      if (drawn > 0) out.write(`\x1b[${drawn}A`); // cursor up to the block start
      for (const line of lines) out.write('\x1b[2K' + line + '\n');
      const pad = drawn > lines.length ? drawn - lines.length : 0;
      for (let i = 0; i < pad; i++) out.write('\x1b[2K\n');
      drawn = lines.length;
    }
    function cleanup() {
      if (process.stdout.isTTY) out.write('\x1b[?25h');
      rl.close();
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if (key?.name === 'up' || str === 'k') { active = (active - 1 + items.length) % items.length; }
      else if (key?.name === 'down' || str === 'j') { active = (active + 1) % items.length; }
      else if (key?.name === 'return' || key?.name === 'enter') {
        process.stdin.removeListener('keypress', onKey);
        cleanup(); resolve(active); return;
      } else if (key?.name === 'escape' || str === 'q') {
        process.stdin.removeListener('keypress', onKey);
        cleanup(); resolve(null); return;
      } else return;
      if (active < pageStart) pageStart = active;
      if (active >= pageStart + pageSize) pageStart = active - pageSize + 1;
      draw();
    };
    process.stdin.on('keypress', onKey);
    draw();
  });
}

// ---- prompts -----------------------------------------------------------------

function promptLine(question, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(C.accent + question + (defaultValue ? C.dim + ` [${defaultValue}]` : '') + C.accent + ': ' + C.reset, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

/// Secrets: characters are not echoed back.
function askSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (stringToWrite) => {
      if (stringToWrite.includes(question)) original(C.accent + question + ': ' + C.reset);
      else if (stringToWrite.trim() && !stringToWrite.includes('\n')) original('*');
      else original(stringToWrite);
    };
    rl.question(question + ': ', (answer) => {
      rl.close();
      say('');
      resolve(answer.trim());
    });
  });
}

function say(text = '') { process.stdout.write(text + '\n'); }

module.exports = { C, banner, printBanner, renderMenu, pickMenu, promptLine, askSecret, say };
