'use strict';
// Account sync: переносит чаты и профиль провайдера в хранилище аккаунта
// (Cloudflare Worker, AES-GCM на сервере) и обратно. Ключ провайдера
// синхронизируется только если пользователь включил синхронизацию ключей.

const sessions = require('./sessions');
const say = (t = '') => process.stdout.write(t + String.fromCharCode(10));

function accountConfig(configStore) {
  const cfg = configStore.resolve();
  if (!cfg.accountToken || !cfg.accountUrl) {
    throw new Error('Нужен аккаунт: notcode config set accountUrl <адрес воркера> и notcode config set accountToken <ncs_…>');
  }
  return { accountUrl: cfg.accountUrl.replace(/\/+$/, ''), accountToken: cfg.accountToken };
}

async function vaultRequest(account, method, path, body) {
  const response = await fetch(account.accountUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${account.accountToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function providerProfile(configStore, includeKey) {
  const cfg = configStore.resolve();
  if (!cfg.baseUrl || !cfg.model) return null;
  const profile = { name: 'CLI', baseUrl: cfg.baseUrl, models: [cfg.model], updatedAt: Date.now() };
  if (includeKey && cfg.key) profile.key = cfg.key;
  return profile;
}

async function push(configStore, root, includeKey) {
  const account = accountConfig(configStore);
  const profile = providerProfile(configStore, includeKey);
  const items = [];
  if (profile) items.push({ kind: 'provider', id: 'cli-default', updatedAt: Date.now(), data: profile });
  for (const session of sessions.list()) {
    const loaded = sessions.load(session.id);
    items.push({
      kind: 'chat',
      id: session.id,
      updatedAt: session.updatedAt,
      data: { name: loaded.name || session.name, model: loaded.model, messages: loaded.messages || [] },
    });
  }
  const result = await vaultRequest(account, 'PUT', '/api/vault', { items });
  sayCounts(`Отправлено в аккаунт`, items.length, result);
}

async function pull(configStore, root, writeKey) {
  const account = accountConfig(configStore);
  const data = await vaultRequest(account, 'GET', '/api/vault');
  let chats = 0, providers = 0;
  for (const item of data.items || []) {
    if (item.kind === 'chat') {
      const local = sessions.list().find(s => s.id === item.id);
      if (local && local.updatedAt >= item.updatedAt) continue; // локальное новее
      sessions.save({
        id: item.id,
        name: item.data.name || 'чат',
        model: item.data.model || '',
        messages: item.data.messages || [],
        updatedAt: item.updatedAt,
      });
      chats++;
    } else if (item.kind === 'provider') {
      providers++;
      const profile = item.data || {};
      const current = configStore.resolve();
      const applyKey = writeKey && typeof profile.key === 'string' && profile.key;
      if (!current.model || applyKey || item.data.default) {
        configStore.save({
          baseUrl: profile.baseUrl,
          model: Array.isArray(profile.models) ? profile.models[0] : current.model,
          ...(applyKey ? { key: profile.key } : {}),
        });
      }
    }
  }
  say(`Загружено из аккаунта: чатов ${chats}, провайдеров ${providers}.`);
}

function sayCounts(prefix, count, result) {
  const stored = (result.stored || []).length;
  process.stdout.write(`${prefix}: ${count} → сервер принял ${stored}.\n`);
}

module.exports = { push, pull, accountConfig, vaultRequest, providerProfile };
