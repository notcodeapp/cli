'use strict';
// Agent tools. Every path operation is sandboxed to the project root; every
// mutating action goes through an approval callback and never runs silently.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// ---- path sandbox -----------------------------------------------------------

function resolveSafe(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) {
    throw new Error('Нужен путь внутри проекта');
  }
  if (relative.includes('\0') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(relative)) {
    throw new Error('Путь содержит недопустимые символы');
  }
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Путь вне проекта запрещён');
  }
  return candidate;
}

function relFrom(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

// ---- unified diff (line-based LCS) ------------------------------------------

function lines(text) {
  return text.length ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
}

function unifiedDiff(oldText, newText, label) {
  const a = lines(oldText);
  const b = lines(newText);
  // LCS table; files are capped at 1 MiB so the O(n·m) table is acceptable.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0, j = 0;
  const emit = (chunk) => out.push(...chunk);
  let chunk = [];
  const flush = (ctx) => { if (chunk.length) { emit(ctx.map(l => ' ' + l)); chunk = []; } };
  while (i < n && j < m) {
    if (a[i] === b[j]) { chunk.push(a[i]); i++; j++; continue; }
    flush(chunk.slice(-3));
    let li = i, lj = j;
    while (li < n && lj < m && a[li] !== b[lj]) {
      if (dp[li + 1][j] >= dp[li][lj + 1]) { out.push(`-${a[li]}`); li++; }
      else { out.push(`+${b[lj]}`); lj++; }
    }
    while (li < n) { out.push(`-${a[li]}`); li++; }
    while (lj < m) { out.push(`+${b[lj]}`); lj++; }
    i = li; j = lj;
    chunk = a.slice(i, i + 3);
    i += chunk.length; j += chunk.length;
    flush([]); // context after the change
  }
  if (i < n || j < m) {
    flush(chunk.slice(0, 3));
    while (i < n) { out.push(`-${a[i]}`); i++; }
    while (j < m) { out.push(`+${b[j]}`); j++; }
  } else {
    flush(chunk.slice(-3));
  }
  return out.join('\n');
}

// ---- tool schema (OpenAI function calling) ----------------------------------

function toolDefinitions() {
  return [
    { type: 'function', function: { name: 'list_files', description: 'List files and folders directly inside a project-relative folder. Use an empty path for the project root.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file inside the project. Read a file before editing it.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a project file with complete UTF-8 content. Requires user approval; the user sees the diff. Never write without reading an existing file first.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command inside the project (build, test, inspect). Requires user approval, cannot prompt for input, killed when the timeout elapses.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, required: ['command'] } } },
  ];
}

// ---- execution --------------------------------------------------------------

function listFiles(root, rel) {
  const dir = rel && rel.trim() ? resolveSafe(root, rel) : root;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .slice(0, 2000)
    .map(e => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
}

function readFile(root, rel) {
  const target = resolveSafe(root, rel);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('Это не файл');
  if (stat.size > MAX_READ_BYTES) throw new Error('Файл больше 256 КиБ — читайте частями или используйте команды');
  return fs.readFileSync(target, 'utf8');
}

async function writeFile(root, rel, content, approve) {
  const target = resolveSafe(root, rel);
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error('Файл больше 1 МиБ');
  }
  const exists = fs.existsSync(target);
  const previous = exists ? fs.readFileSync(target, 'utf8') : '';
  const diff = unifiedDiff(previous, content, relFrom(root, target));
  if (exists && previous === content) {
    return { ok: true, unchanged: true, message: 'Файл уже содержит этот текст — запись не потребовалась.' };
  }
  const approved = await approve({
    kind: 'write',
    path: relFrom(root, target),
    isNew: !exists,
    diff,
  });
  if (!approved) {
    return { ok: false, denied: true, message: 'Пользователь отклонил запись. Не повторяйте её; объясните, что правка отклонена.' };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { ok: true, path: relFrom(root, target), bytes: Buffer.byteLength(content, 'utf8') };
}

async function runCommand(root, command, timeoutSeconds, approve, env) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) {
    throw new Error('Команда должна быть строкой 1–4096 символов');
  }
  const timeout = Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const approved = await approve({ kind: 'command', command, timeoutMs: timeout, cwd: root });
  if (!approved) {
    return { ok: false, denied: true, message: 'Пользователь отклонил команду. Не запускайте её снова; предложите альтернативу.' };
  }
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      env: { ...process.env, ...env, NOTCODE: '1' },
      windowsHide: true,
    });
    let stdout = '', stderr = '', killed = false;
    const collect = (chunk, push) => {
      if (stdout.length + stderr.length < MAX_OUTPUT_BYTES) push(chunk);
    };
    child.stdout.on('data', c => collect(c, x => { stdout += x; }));
    child.stderr.on('data', c => collect(c, x => { stderr += x; }));
    const timer = setTimeout(() => {
      killed = true;
      // On Windows the shell outlives a plain kill and holds the pipes, so
      // take down the whole process tree.
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const clip = (t) => t.length >= MAX_OUTPUT_BYTES ? t.slice(0, MAX_OUTPUT_BYTES) + '\n…[вывод обрезан]' : t;
      resolvePromise({
        ok: true,
        exitCode: code,
        killed,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    });
  });
}

module.exports = {
  MAX_READ_BYTES, MAX_WRITE_BYTES, MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
  resolveSafe, relFrom, unifiedDiff, toolDefinitions,
  listFiles, readFile, writeFile, runCommand,
};
