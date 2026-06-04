#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DISPLAY_NAMES = path.join(SCRIPT_DIR, 'provider-display-names.json');
const FETCH_TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
let providerName, providerDisplayName, baseUrlRaw, apiKey;
if (args.length >= 4) {
  [providerName, providerDisplayName, baseUrlRaw, apiKey] = args;
} else {
  [providerName, baseUrlRaw, apiKey] = args;
  providerDisplayName = providerName;
}
if (!providerName || !baseUrlRaw || !apiKey) {
  console.error('Usage: node add-provider.mjs <providerName> [providerDisplayName] <baseUrl> <apiKey>');
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

function ensureJsonFile(file, fallback) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\n');
    return structuredClone(fallback);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\n');
  return structuredClone(fallback);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${year}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createConfigBackup() {
  const backup = `${CONFIG}-${formatBackupTimestamp()}`;
  fs.copyFileSync(CONFIG, backup);
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

const displayNames = ensureJsonFile(DISPLAY_NAMES, {});
displayNames[providerName] = providerDisplayName;
writeJson(DISPLAY_NAMES, displayNames);

const providerModels = ids.map(id => normalizeModel(providerDisplayName, id));
cfg.models.providers[providerName] = {
  baseUrl,
  apiKey,
  api: 'openai-completions',
  models: providerModels,
};

for (const id of ids) {
  const ref = `${providerName}/${id}`;
  if (!cfg.agents.defaults.models[ref]) cfg.agents.defaults.models[ref] = {};
}

const backup = createConfigBackup();
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

console.log(`Added provider ${providerName}`);
console.log(`Display name: ${providerDisplayName}`);
console.log(`Config: ${CONFIG}`);
console.log(`Base URL: ${baseUrl}`);
console.log(`Models fetched: ${ids.length}`);
console.log(`Backup: ${backup}`);
console.log('Sample models:');
for (const id of ids.slice(0, 20)) console.log(`- ${providerName}/${id}`);
