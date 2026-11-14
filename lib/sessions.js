'use strict';
// Chat sessions: each conversation persists to ~/.notcode/sessions/*.json so
// any exchange survives a restart and can be continued later.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_SESSIONS = 50;

function sessionsDir() {
  return path.join(os.homedir(), '.notcode', 'sessions');
}

function slug(text) {
  return (text || 'chat')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'chat';
}

function save(session) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  session.id = session.id || `${Date.now()}-${slug(session.name)}`;
  session.updatedAt = Date.now();
  const file = path.join(dir, session.id + '.json');
  fs.writeFileSync(file, JSON.stringify({ ...session, file: undefined }, null, 1), { mode: 0o600 });
  prune();
  return session;
}

function prune() {
  const files = list()
    .map(s => s.file)
    .slice(MAX_SESSIONS);
  for (const file of files) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } }
}

function list() {
  const dir = sessionsDir();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const sessions = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      sessions.push({
        id: name.replace(/\.json$/, ''),
        name: String(data.name || 'чат').slice(0, 60),
        model: String(data.model || ''),
        updatedAt: Number(data.updatedAt) || 0,
        turns: Array.isArray(data.messages) ? data.messages.length : 0,
        file: path.join(dir, name),
      });
    } catch { /* broken file — skip */ }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function load(id) {
  const file = path.join(sessionsDir(), id.replace(/\.json$/, '') + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...data, id: id.replace(/\.json$/, ''), file };
}

function remove(id) {
  try { fs.rmSync(path.join(sessionsDir(), id.replace(/\.json$/, '') + '.json'), { force: true }); } catch { /* fine */ }
}

module.exports = { sessionsDir, save, list, load, remove, slug };
