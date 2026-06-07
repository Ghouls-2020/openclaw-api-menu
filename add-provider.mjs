#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DISPLAY_NAMES = path.join(SCRIPT_DIR, 'provider-display-names.json');
const FETCH_TIMEOUT_MS = 3000;
const CONFIG_BACKUP_KEEP_MAX = 20;

const args = process.argv.slice(2);
let providerName, providerDisplayName, baseUrlRaw, apiKey;
if (args[0] === '--stdin') {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    providerName = payload.providerName;
    providerDisplayName = payload.providerDisplayName || payload.providerName;
    baseUrlRaw = payload.baseUrl;
    apiKey = payload.apiKey;
  } catch (err) {
    console.error(`Failed to read stdin payload: ${err.message}`);
    process.exit(1);
  }
} else if (args.length >= 4) {
  [providerName, providerDisplayName, baseUrlRaw, apiKey] = args;
} else {
  [providerName, baseUrlRaw, apiKey] = args;
  providerDisplayName = providerName;
}
if (!providerName || !baseUrlRaw || !apiKey) {
  console.error('Usage: node add-provider.mjs --stdin OR <providerName> [providerDisplayName] <baseUrl> <apiKey>');
  process.exit(1);
}
function isValidProviderId(value) {
  return /^[a-zA-Z0-9_-]+$/.test(String(value || ''));
}
if (!isValidProviderId(providerName)) {
  console.error('provider id 格式无效,只能包含字母、数字、下划线(_)和短横线(-)。');
  process.exit(1);
}

const baseUrl = normalizeAndValidateBaseUrl(baseUrlRaw);
if (!baseUrl) {
  console.error('Base URL 格式无效,请输入以 http:// 或 https:// 开头的完整 URL。');
  process.exit(1);
}
const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

if (!fs.existsSync(CONFIG)) {
  console.error(`OpenClaw config not found: ${CONFIG}`);
  console.error('Run OpenClaw at least once first so openclaw.json exists.');
  process.exit(1);
}

function normalizeAndValidateBaseUrl(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return text.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function atomicWriteJsonFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function ensureJsonFile(file, fallback) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    atomicWriteJsonFile(file, fallback);
    return structuredClone(fallback);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    const corruptPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, corruptPath, fs.constants.COPYFILE_EXCL); } catch {}
  }
  try {
    const invalidPath = `${file}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (fs.existsSync(file)) fs.copyFileSync(file, invalidPath, fs.constants.COPYFILE_EXCL);
  } catch {}
  atomicWriteJsonFile(file, fallback);
  return structuredClone(fallback);
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function runConfigPatch(patch) {
  return spawnSync('openclaw', ['config', 'patch', '--stdin'], {
    input: JSON.stringify(patch, null, 2),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${year}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function sanitizeBackupTag(tag = 'manual') {
  return String(tag || 'manual').trim().replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'manual';
}

function cleanupConfigBackups() {
  const dir = path.dirname(CONFIG);
  const base = path.basename(CONFIG);
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}-`))
      .map((name) => {
        const fullPath = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  for (const item of entries.slice(CONFIG_BACKUP_KEEP_MAX)) {
    try {
      fs.unlinkSync(item.fullPath);
    } catch {}
  }
}

function createConfigBackup(tag = 'manual') {
  const backup = `${CONFIG}-${formatBackupTimestamp()}-${sanitizeBackupTag(tag)}`;
  fs.copyFileSync(CONFIG, backup, fs.constants.COPYFILE_EXCL);
  cleanupConfigBackups();
  return backup;
}

function guessInputCaps(id) {
  const s = String(id).toLowerCase();
  if (/(vision|vl|image|4o|gemini|gpt-4\.1|o4)/.test(s)) return ['text', 'image'];
  return ['text'];
}

function normalizeModel(displayName, id) {
  return {
    id,
    name: `${displayName} / ${id}`,
    input: guessInputCaps(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 128000,
  };
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

let res;
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
try {
  res = await fetch(modelsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
} catch (err) {
  clearTimeout(timeoutId);
  console.error(`Failed to connect to ${modelsUrl}`);
  if (err.name === 'AbortError') {
    console.error(`请求超时:${FETCH_TIMEOUT_MS}ms，请检查网关或 Base URL。`);
  } else if (err.cause?.code === 'ENOTFOUND') {
    console.error(`域名解析失败: ${err.cause.hostname}`);
    console.error('请检查 Base URL 是否正确，或检查 DNS/网络连接。');
  } else if (err.cause?.code === 'ECONNREFUSED') {
    console.error('连接被拒绝，请检查服务是否可用。');
  } else {
    console.error(err.message);
  }
  process.exit(2);
}

if (!res.ok) {
  const text = await res.text().catch(() => '');
  console.error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);
  if (text) console.error(text.slice(0, 1000));
  process.exit(2);
}

const data = await res.json();
const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
const ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];
if (!ids.length) {
  console.error('No model IDs found in /models response');
  process.exit(3);
}

const providerModels = ids.map(id => normalizeModel(providerDisplayName, id));
const modelsPatch = { [`${providerName}/*`]: {} };

const backup = createConfigBackup();
const patchRes = runConfigPatch({
  models: {
    providers: {
      [providerName]: {
        baseUrl,
        apiKey,
        api: 'openai-completions',
        models: providerModels,
      },
    },
  },
  agents: {
    defaults: {
      models: modelsPatch,
    },
  },
});
if (patchRes.status !== 0) {
  console.error('Failed to apply config patch');
  if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
  if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
  process.exit(patchRes.status || 4);
}

const displayNames = ensureJsonFile(DISPLAY_NAMES, {});
displayNames[providerName] = providerDisplayName;
writeJson(DISPLAY_NAMES, displayNames);

console.log(`Added provider ${providerName}`);
console.log(`Display name: ${providerDisplayName}`);
console.log(`Config: ${CONFIG}`);
console.log(`Base URL: ${baseUrl}`);
console.log(`Models fetched: ${ids.length}`);
console.log(`Backup: ${backup}`);
console.log('Sample models:');
for (const id of ids.slice(0, 20)) console.log(`- ${providerName}/${id}`);
