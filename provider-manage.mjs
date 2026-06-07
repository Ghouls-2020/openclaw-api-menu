#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const rawArgs = process.argv.slice(2);
const noBackup = rawArgs.includes('--no-backup');
const args = rawArgs.filter((arg) => arg !== '--no-backup');
const [action, providerInput, providerDisplayName] = args;
if (!action || !providerInput || !['check','sync','remove','rename'].includes(action)) {
  console.error('Usage: node provider-manage.mjs <check|sync|remove|rename> <providerNameOrDisplayName> [providerDisplayName]');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');
const FETCH_TIMEOUT_MS = 3000;
const CONFIG_BACKUP_KEEP_MAX = 20;
if (!fs.existsSync(CONFIG)) {
  console.error(`OpenClaw config not found: ${CONFIG}`);
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

function runConfigPatch(patch, extraArgs = []) {
  return spawnSync('openclaw', ['config', 'patch', ...extraArgs, '--stdin'], {
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

function maybeCreateConfigBackup() {
  return noBackup ? null : createConfigBackup();
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

const providers = cfg.models.providers || {};
const modelMap = cfg.agents.defaults.models || {};
const displayNames = ensureJsonFile(DISPLAY_NAMES, {});

function resolveProviderKey(input) {
  if (providers[input]) return input;
  const lowered = String(input).toLowerCase();
  for (const key of Object.keys(providers)) {
    if (key.toLowerCase() === lowered) return key;
  }
  for (const [key, value] of Object.entries(displayNames)) {
    if (String(value).toLowerCase() === lowered && providers[key]) return key;
  }
  return null;
}

const providerName = resolveProviderKey(providerInput);
const provider = providerName ? providers[providerName] : null;

function refsFor(name) {
  return Object.keys(modelMap).filter(k => k.split('/')[0].toLowerCase() === name.toLowerCase());
}

function isProviderRef(ref, name) {
  return typeof ref === 'string' && ref.split('/')[0]?.toLowerCase() === name.toLowerCase();
}

function buildDefaultSelectionPatch(defaults = {}) {
  const patch = {};
  for (const field of ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel']) {
    if (Object.prototype.hasOwnProperty.call(defaults, field)) patch[field] = defaults[field];
  }
  return patch;
}

function pruneModelSelection(config, name) {
  const defaults = config.agents?.defaults;
  if (!defaults) return;

  const pruneSelectionField = (fieldName) => {
    const value = defaults[fieldName];
    if (typeof value === 'string') {
      if (isProviderRef(value, name)) delete defaults[fieldName];
      return;
    }
    if (value && typeof value === 'object') {
      if (isProviderRef(value.primary, name)) delete value.primary;
      if (Array.isArray(value.fallbacks)) {
        value.fallbacks = value.fallbacks.filter((ref) => !isProviderRef(ref, name));
      }
      if (!value.primary && (!Array.isArray(value.fallbacks) || value.fallbacks.length === 0)) {
        delete defaults[fieldName];
      }
    }
  };

  pruneSelectionField('model');
  pruneSelectionField('imageModel');
  pruneSelectionField('pdfModel');
  pruneSelectionField('audioModel');
  pruneSelectionField('videoGenerationModel');
  pruneSelectionField('musicGenerationModel');
}

function guessInputCaps(id) {
  return /(vision|vl|image|4o|gemini|gpt-4\.1|o4)/i.test(id) ? ['text', 'image'] : ['text'];
}

function getProviderDisplayName(name) {
  return displayNames[name] || name;
}

if (action === 'check') {
  if (!provider || !providerName) {
    console.log(`Provider not found: ${providerInput}`);
    process.exit(2);
  }
  const refs = refsFor(providerName);
  console.log(`Provider: ${providerName}`);
  console.log(`Display name: ${getProviderDisplayName(providerName)}`);
  console.log(`Base URL: ${provider.baseUrl || '<none>'}`);
  console.log(`API mode: ${provider.api || '<none>'}`);
  console.log(`Configured provider.models: ${Array.isArray(provider.models) ? provider.models.length : 0}`);
  console.log(`agents.defaults.models refs: ${refs.length}`);
  for (const ref of refs.slice(0, 20)) console.log(`- ${ref}`);
  process.exit(0);
}

if (action === 'rename') {
  if (!provider || !providerName) {
    console.error(`Provider not found: ${providerInput}`);
    process.exit(2);
  }
  if (!providerDisplayName) {
    console.error('Usage: node provider-manage.mjs rename <providerNameOrDisplayName> <providerDisplayName>');
    process.exit(3);
  }
  const backup = maybeCreateConfigBackup();
  displayNames[providerName] = providerDisplayName;
  writeJson(DISPLAY_NAMES, displayNames);
  if (Array.isArray(provider.models)) {
    provider.models = provider.models.map((model) => ({
      ...model,
      name: `${providerDisplayName} / ${model.id}`,
    }));
  }
  const patchRes = runConfigPatch({
    models: {
      providers: {
        [providerName]: provider,
      },
    },
  });
  if (patchRes.status !== 0) {
    console.error('Failed to apply config patch');
    if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
    if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
    process.exit(patchRes.status || 4);
  }
  console.log(`Renamed provider display: ${providerName} -> ${providerDisplayName}`);
  if (backup) console.log(`Backup: ${backup}`);
  process.exit(0);
}

if (action === 'remove') {
  if (!provider || !providerName) {
    console.error(`Provider not found: ${providerInput}`);
    process.exit(2);
  }
  const modelConfig = cfg.agents?.defaults?.model;
  const currentPrimary = typeof modelConfig === 'string' ? modelConfig : modelConfig?.primary;
  if (typeof currentPrimary === 'string') {
    const [pfx] = currentPrimary.split('/');
    if (pfx.toLowerCase() === providerName.toLowerCase()) {
      console.error(`Refusing to remove ${providerName}: default primary model is still using it (${currentPrimary})`);
      process.exit(3);
    }
  }
  const backup = maybeCreateConfigBackup();
  delete cfg.models.providers[providerName];
  delete displayNames[providerName];
  writeJson(DISPLAY_NAMES, displayNames);
  let removed = 0;
  const modelRefPatch = { [`${providerName}/*`]: null };
  for (const key of Object.keys(modelMap)) {
    const [pfx] = key.split('/');
    if (pfx.toLowerCase() === providerName.toLowerCase()) {
      modelRefPatch[key] = null;
      removed += 1;
    }
  }
  pruneModelSelection(cfg, providerName);
  const patchRes = runConfigPatch({
    models: {
      providers: {
        [providerName]: null,
      },
    },
    agents: {
      defaults: {
        ...buildDefaultSelectionPatch(cfg.agents?.defaults || {}),
        models: modelRefPatch,
      },
    },
  });
  if (patchRes.status !== 0) {
    console.error('Failed to apply config patch');
    if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
    if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
    process.exit(patchRes.status || 4);
  }
  console.log(`Removed provider: ${providerName}`);
  console.log(`Removed refs: ${removed}`);
  if (backup) console.log(`Backup: ${backup}`);
  process.exit(0);
}

if (action === 'sync') {
  if (!provider || !providerName) {
    console.error(`Provider not found: ${providerInput}`);
    process.exit(2);
  }
  if (!provider.baseUrl || !provider.apiKey) {
    console.error(`Provider ${providerName} is missing baseUrl or apiKey in config`);
    process.exit(3);
  }
  const baseUrl = normalizeAndValidateBaseUrl(provider.baseUrl);
  if (!baseUrl) {
    console.error('Base URL 格式无效,请输入以 http:// 或 https:// 开头的完整 URL。');
    process.exit(4);
  }
  const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  let res;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    res = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
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
    process.exit(4);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);
    if (text) console.error(text.slice(0, 1000));
    process.exit(4);
  }
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];
  if (!ids.length) {
    console.error('No model IDs found in /models response');
    process.exit(5);
  }
  const backup = maybeCreateConfigBackup();
  const displayName = getProviderDisplayName(providerName);
  provider.models = ids.map(id => ({
    id,
    name: `${displayName} / ${id}`,
    input: guessInputCaps(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 128000,
  }));
  const wanted = new Set(ids.map(id => `${providerName}/${id}`));
  let added = 0, removed = 0;
  const modelRefPatch = { [`${providerName}/*`]: {} };
  for (const ref of wanted) {
    if (!modelMap[ref]) added += 1;
  }
  for (const [key, value] of Object.entries(modelMap)) {
    if (key === `${providerName}/*`) continue;
    const [pfx] = key.split('/');
    const isEmptyObject = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    if (pfx.toLowerCase() === providerName.toLowerCase() && isEmptyObject) {
      modelRefPatch[key] = null;
      if (!wanted.has(key)) removed += 1;
    }
  }
  const patchRes = runConfigPatch({
    models: {
      providers: {
        [providerName]: provider,
      },
    },
    agents: {
      defaults: {
        models: modelRefPatch,
      },
    },
  }, ['--replace-path', `models.providers.${providerName}.models`]);
  if (patchRes.status !== 0) {
    console.error('Failed to apply config patch');
    if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
    if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
    process.exit(patchRes.status || 4);
  }
  console.log(`Synced provider: ${providerName}`);
  console.log(`Display name: ${displayName}`);
  console.log(`Models now present: ${ids.length}`);
  console.log(`Added refs: ${added}`);
  console.log(`Removed stale refs: ${removed}`);
  if (backup) console.log(`Backup: ${backup}`);
}
