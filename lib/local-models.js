'use strict';
// Локальные модели через Ollama: характеристики компьютера → рекомендуемые
// модели → скачивание с прогрессом → автозапуск сервера. Без зависимостей:
// os для RAM/CPU, nvidia-smi/wmic для GPU, HTTP API 11434 для управления.

const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const http = require('node:http');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const OPENAI_PATH = '/v1';
const VERSION_TIMEOUT_MS = 5_000;
const SERVE_START_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 60 * 60 * 1000;

// ---- каталог локальных моделей ------------------------------------------------
// ramGb — практическая память под Q4-квантование (веса + контекст + запас).

const LOCAL_CATALOG = [
  { name: 'qwen2.5-coder:1.5b', ramGb: 2.5, coding: true, note: 'сверхлёгкая для кода' },
  { name: 'qwen2.5-coder:7b', ramGb: 6, coding: true, note: 'лучший баланс код/скорость' },
  { name: 'qwen2.5-coder:14b', ramGb: 11, coding: true, note: 'сильная код-модель' },
  { name: 'qwen2.5-coder:32b', ramGb: 22, coding: true, note: 'почти облачный уровень' },
  { name: 'qwen3-coder:30b', ramGb: 20, coding: true, note: 'MoE-агент для кода' },
  { name: 'deepseek-coder-v2:16b', ramGb: 11, coding: true, note: 'MoE, быстрый для 16B' },
  { name: 'codellama:7b', ramGb: 6, coding: true, note: 'классика Meta для кода' },
  { name: 'codellama:13b', ramGb: 10, coding: true, note: 'Meta, крупнее' },
  { name: 'llama3.1:8b', ramGb: 7, coding: false, note: 'универсальная Meta' },
  { name: 'qwen3:4b', ramGb: 4, coding: false, note: 'reasoning, компактная' },
  { name: 'qwen3:8b', ramGb: 7, coding: false, note: 'reasoning, сбалансированная' },
  { name: 'phi4:14b', ramGb: 11, coding: false, note: 'Microsoft, reasoning' },
  { name: 'gemma3:4b', ramGb: 4, coding: false, note: 'Google, мультимодальная' },
  { name: 'gemma3:12b', ramGb: 9, coding: false, note: 'Google, средняя' },
  { name: 'mistral:7b', ramGb: 6, coding: false, note: 'быстрая универсальная' },
];

// ---- железо -------------------------------------------------------------------

function execText(command, args, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? '').trim());
      });
    } catch {
      resolve('');
    }
  });
}

/// VRAM только для NVIDIA: nvidia-smi есть почти на любой машине с дискретной
/// NVIDIA; для AMD/Intel VRAM из ОС недоступна — считается 0 (-shared memory).
async function detectHardware() {
  const ramGb = os.totalmem() / 1024 ** 3;
  const cpus = os.cpus();
  const cpu = cpus.length ? `${cpus[0].model.trim()} · ${cpus.length} ядер` : 'CPU';
  let gpu = null;
  let vramGb = 0;
  const smi = await execText('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], 6_000);
  if (smi) {
    const [name, mem] = smi.split('\n')[0].split(',').map((v) => v.trim());
    gpu = name || 'NVIDIA GPU';
    vramGb = parseFloat(mem) / 1024 || 0;
  } else if (process.platform === 'win32') {
    const names = await execText('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | Select-Object -First 2'], 8_000);
    const first = names.split('\n').map((v) => v.trim()).filter(Boolean)[0];
    if (first) gpu = first;
  } else {
    const lspci = await execText('lspci', [], 6_000);
    const vga = lspci.split('\n').find((l) => /vga|3d/i.test(l));
    if (vga) gpu = vga.split(':')[2]?.trim() || vga.trim();
  }
  return { ramGb: Math.round(ramGb * 10) / 10, cpu, gpu, vramGb: Math.round(vramGb * 10) / 10 };
}

/// Доступная модель память: RAM минус запас на систему/контекст, плюс VRAM GPU.
function usableMemoryGb(hardware) {
  const ramBudget = Math.max(hardware.ramGb - 2.5, 0);
  return ramBudget + hardware.vramGb;
}

/// Разделяет каталог: рекомендуемые (влезают в память, код-модели выше) и
/// «за гранью» — запустятся из подкачки, заметно медленнее.
function recommend(hardware, catalog = LOCAL_CATALOG, installed = []) {
  const budget = usableMemoryGb(hardware);
  const known = new Set(installed);
  const decorate = (item) => ({ ...item, installed: known.has(item.name), fits: item.ramGb <= budget });
  const all = catalog.map(decorate);
  const sort = (a, b) => Number(b.coding) - Number(a.coding) || a.ramGb - b.ramGb;
  const recommended = all.filter((m) => m.fits).sort(sort);
  const beyond = all.filter((m) => !m.fits).sort(sort);
  return { budget: Math.round(budget * 10) / 10, recommended, beyond };
}

// ---- ollama: наличие, сервер, модели, скачивание -------------------------------

function findOllama() {
  const candidates = process.platform === 'win32'
    ? [
        ['ollama', []],
        [String.raw`${process.env.LOCALAPPDATA ?? ''}\Programs\Ollama\ollama.exe`, []],
        ['C:\\Program Files\\Ollama\\ollama.exe', []],
      ]
    : [['ollama', []]];
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) return resolve(null);
      const [command, args] = candidates[index++];
      execFile(command, [...args, '--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) return tryNext();
        resolve({ command, args, version: String(stdout ?? '').trim() });
      });
    };
    tryNext();
  });
}

function versionRequest(timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(`${OLLAMA_URL}/api/version`, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

/// Сервер должен отвечать; если нет — поднимаем `ollama serve` в фоне и ждём.
async function ensureServe(ollama) {
  if (await versionRequest(2_000)) return { started: false };
  const child = spawn(ollama.command, [...ollama.args, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + SERVE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await versionRequest(1_500)) return { started: true };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Ollama не отвечает после запуска — попробуй запустить вручную: ollama serve');
}

async function installedModels() {
  const raw = await new Promise((resolve) => {
    const request = http.get(`${OLLAMA_URL}/api/tags`, { timeout: 5_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => { request.destroy(); resolve(''); });
    request.on('error', () => resolve(''));
  });
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (parsed.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/// Парсер строк прогресса ollama pull: {"status":"pulling …","total":N,"completed":M}
/// и финал {"status":"success"}. Чистая функция — покрыта тестом.
function parsePullLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const data = JSON.parse(trimmed);
    if (data.status === 'success') return { done: true };
    if (typeof data.total === 'number' && data.total > 0) {
      const done = typeof data.completed === 'number' ? data.completed : 0;
      return { fraction: Math.min(done / data.total, 1), totalBytes: data.total, doneBytes: done };
    }
    if (typeof data.status === 'string') return { status: data.status };
  } catch { /* промежуточный мусор игнорируем */ }
  return null;
}

/// Скачивание: живой прогресс колбэком, ошибка — с текстом из stderr.
function pullModel(ollama, model, onProgress = () => {}, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ollama.command, [...ollama.args, 'pull', model], {
      windowsHide: true,
    });
    let stdoutBuffer = '';
    let stderr = '';
    let success = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Скачивание прервано по таймауту (60 минут)'));
    }, PULL_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timer);
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); }, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const progress = parsePullLine(line);
        if (progress) {
          if (progress.done) {
            success = true;
            onProgress({ fraction: 1 });
          } else {
            onProgress(progress);
          }
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 16_000) stderr = stderr.slice(-16_000); });
    child.on('error', (error) => { cleanup(); reject(new Error(`ollama не запустился: ${error.message}`)); });
    child.on('close', (code) => {
      cleanup();
      if (code === 0 || success) return resolve({ ok: true });
      reject(new Error(`ollama pull завершился с кодом ${code}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`));
    });
  });
}

module.exports = {
  OLLAMA_URL, OPENAI_PATH, LOCAL_CATALOG,
  detectHardware, usableMemoryGb, recommend,
  findOllama, ensureServe, installedModels, parsePullLine, pullModel,
};
