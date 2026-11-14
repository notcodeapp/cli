'use strict';
// Config: ~/.notcode/config.json holds baseUrl/model. The API key lives in the
// NOTCODE_API_KEY environment variable or, as a fallback, in the same file —
// written with 0600 on POSIX. The key is never sent anywhere except the
// configured provider.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const KNOWN_KEYS = ['baseUrl', 'model', 'key', 'accountUrl', 'accountToken', 'syncKey'];

function configPath() {
  return path.join(os.homedir(), '.notcode', 'config.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const clean = {};
    for (const key of KNOWN_KEYS) if (typeof raw[key] === 'string') clean[key] = raw[key];
    return clean;
  } catch {
    return {};
  }
}

function save(patch) {
  const merged = { ...load(), ...patch };
  for (const key of Object.keys(merged)) {
    if (!KNOWN_KEYS.includes(key) || typeof merged[key] !== 'string') delete merged[key];
  }
  if (typeof merged.baseUrl === 'string') merged.baseUrl = merged.baseUrl.replace(/\/+$/, '');
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: default user ACL */ }
  return merged;
}

// Effective settings: env key wins over the stored one.
function resolve(overrides = {}) {
  const stored = load();
  const baseUrl = String(overrides.baseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = String(overrides.model ?? stored.model ?? '');
  const key = process.env.NOTCODE_API_KEY || overrides.key || stored.key || '';
  return { baseUrl, model, key };
}

// Validates an OpenAI-compatible base URL: https (or http loopback for local
// gateways like Ollama/LM Studio), no credentials or fragments.
function validateBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'Адрес должен быть полным URL: https://…'; }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) return 'Адрес должен использовать HTTPS (или http на 127.0.0.1)';
  if (url.username || url.password) return 'Уберите логин и пароль из адреса';
  if (url.hash) return 'Адрес не должен содержать #фрагмент';
  if (!url.hostname) return 'В адресе нет хоста';
  return null;
}

module.exports = { DEFAULT_BASE_URL, configPath, load, save, resolve, validateBaseUrl };
