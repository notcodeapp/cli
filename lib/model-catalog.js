'use strict';
// Каталог моделей с метаданными: контекстное окно, описания, бесплатность.
// Данные собраны из официальных источников (docs провайдеров + models.dev).
// Ключ = подстрока ID модели (lowercase), совпадение — по включению.

const CATALOG = [
  // --- OpenRouter free tier ---
  { match: 'deepseek/deepseek-r1:free', ctx: 163840, free: true, desc: 'Reasoning-модель DeepSeek, бесплатно через OpenRouter' },
  { match: 'deepseek/deepseek-chat-v3-0324:free', ctx: 163840, free: true, desc: 'DeepSeek V3 — сильная универсальная модель' },
  { match: 'meta-llama/llama-3.3-70b-instruct:free', ctx: 131072, free: true, desc: 'Meta Llama 3.3 70B — качественная open-source' },
  { match: 'qwen/qwen-2.5-72b-instruct:free', ctx: 32768, free: true, desc: 'Qwen 2.5 72B — хорошая для кода' },
  { match: 'google/gemini-2.0-flash-exp:free', ctx: 1048576, free: true, desc: 'Gemini 2.0 Flash — огромный контекст' },
  { match: 'mistralai/mistral-7b-instruct:free', ctx: 32768, free: true, desc: 'Mistral 7B — быстрая маленькая' },
  { match: 'microsoft/phi-3-medium-128k-instruct:free', ctx: 131072, free: true, desc: 'Phi-3 Medium от Microsoft' },
  // --- DeepSeek ---
  { match: 'deepseek-chat', ctx: 65536, free: false, desc: 'DeepSeek V3 — универсальная, дешёвая' },
  { match: 'deepseek-reasoner', ctx: 65536, free: false, desc: 'DeepSeek R1 — reasoning, показывает цепочку мыслей' },
  // --- Anthropic (через провайдеров) ---
  { match: 'claude-sonnet-4', ctx: 200000, free: false, desc: 'Claude Sonnet 4 — лучшая для кода' },
  { match: 'claude-3.5-sonnet', ctx: 200000, free: false, desc: 'Claude 3.5 Sonnet — быстрая и качественная' },
  { match: 'claude-opus-4', ctx: 200000, free: false, desc: 'Claude Opus 4 — самая мощная Anthropic' },
  // --- OpenAI ---
  { match: 'gpt-4o', ctx: 128000, free: false, desc: 'GPT-4o — флагман OpenAI' },
  { match: 'gpt-4o-mini', ctx: 128000, free: false, desc: 'GPT-4o mini — быстрая и дешёвая' },
  { match: 'o3-mini', ctx: 200000, free: false, desc: 'O3-mini — reasoning от OpenAI' },
  // --- Google ---
  { match: 'gemini-2.0-flash', ctx: 1048576, free: false, desc: 'Gemini 2.0 Flash — миллион токенов контекста' },
  { match: 'gemini-1.5-pro', ctx: 2097152, free: false, desc: 'Gemini 1.5 Pro — двухмиллионный контекст' },
  // --- Groq (быстрый инференс) ---
  { match: 'llama-3.3-70b-versatile', ctx: 131072, free: false, desc: 'Llama 3.3 70B на Groq — сверхбыстрая' },
  { match: 'llama-3.1-8b-instant', ctx: 131072, free: false, desc: 'Llama 3.1 8B на Groq — мгновенный отклик' },
  // --- Meta / Mistral / Qwen (общие) ---
  { match: 'llama-3.3-70b', ctx: 131072, free: false, desc: 'Meta Llama 3.3 70B Instruct' },
  { match: 'mistral-large', ctx: 131072, free: false, desc: 'Mistral Large — флагман Mistral AI' },
  { match: 'qwen-2.5-coder-32b', ctx: 32768, free: false, desc: 'Qwen 2.5 Coder 32B — специализированная для кода' },
  { match: 'qwen-max', ctx: 32768, free: false, desc: 'Qwen Max — флагман Alibaba' },
];

const FREE_HINT = 'бесплатно';
const UNKNOWN_CTX = 0;

/// Ищет метаданные модели по её ID (например, "deepseek/deepseek-r1:free").
function lookup(modelId) {
  const lower = (modelId || '').toLowerCase();
  for (const entry of CATALOG) {
    if (lower.includes(entry.match.toLowerCase())) return entry;
  }
  return null;
}

/// Краткое описание для списка выбора: контекст + free-маркер.
function describe(modelId) {
  const entry = lookup(modelId);
  if (!entry) return '';
  const ctxK = Math.round(entry.ctx / 1024);
  const parts = [`контекст ~${ctxK}K`];
  if (entry.free) parts.push(FREE_HINT);
  return parts.join(' · ');
}

/// Возвращает все записи каталога (для отображения полного списка).
function all() { return CATALOG; }

module.exports = { lookup, describe, all, CATALOG, UNKNOWN_CTX };
