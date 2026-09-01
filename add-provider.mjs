#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
const CONFIG = path.join(STATE_DIR, 'openclaw.json');
const DISPLAY_NAMES = path.join(SCRIPT_DIR, 'provider-display-names.json');
const FETCH_TIMEOUT_MS = 8000;

const rawArgs = process.argv.slice(2);
let providerName, providerDisplayName, baseUrlRaw, apiKey;
if (rawArgs[0] === '--stdin') {
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
} else if (rawArgs.length >= 4) {
  [providerName, providerDisplayName, baseUrlRaw, apiKey] = rawArgs;
} else {
  [providerName, baseUrlRaw, apiKey] = rawArgs;
  providerDisplayName = providerName;
}
if (!providerName || !baseUrlRaw || !apiKey || !String(apiKey).trim()) {
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
  // 目标已存在(如修复损坏文件)时保留原权限/属主
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      fs.chmodSync(tmp, st.mode & 0o7777);
      try { fs.chownSync(tmp, st.uid, st.gid); } catch {}
    }
  } catch {}
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
  // 覆盖已存在文件时保留原权限/属主
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      fs.chmodSync(tmp, st.mode & 0o7777);
      try { fs.chownSync(tmp, st.uid, st.gid); } catch {}
    }
  } catch {}
  fs.renameSync(tmp, file);
}

function runConfigPatch(patch) {
  return spawnSync('openclaw', ['config', 'patch', '--stdin'], {
    input: JSON.stringify(patch, null, 2),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
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

function inferProviderDisplayName(provider, fallback = '') {
  if (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string') {
    const inferred = String(provider.models[0].name).split(' / ')[0].trim();
    if (inferred) return inferred;
  }
  return fallback;
}

function findProviderDisplayNameConflict(name, providers = {}, displayNames = {}, excludeId = '') {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return null;
  for (const [id, provider] of Object.entries(providers || {})) {
    if (id === excludeId) continue;
    const names = new Set();
    if (displayNames[id]) names.add(String(displayNames[id]).trim());
    const inferred = inferProviderDisplayName(provider, id);
    if (inferred) names.add(String(inferred).trim());
    for (const candidate of names) {
      if (candidate && candidate.toLowerCase() === text) return { id, name: candidate };
    }
  }
  return null;
}

let cfg; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { console.error('配置 JSON 损坏,无法读取。'); process.exit(1); }
if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};
const displayNames = ensureJsonFile(DISPLAY_NAMES, {});
const displayNameConflict = findProviderDisplayNameConflict(providerDisplayName, cfg.models.providers, displayNames, providerName);
if (displayNameConflict) {
  console.error(`Display name already exists: ${providerDisplayName} (${displayNameConflict.id})`);
  process.exit(2);
}
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

function buildModelPolicyWithProvider(defaults, name) {
  const allow = defaults?.modelPolicy?.allow;
  // 空/缺省策略表示允许所有模型；只有显式启用白名单时才追加，避免意外收紧现有配置。
  if (!Array.isArray(allow) || allow.length === 0) return null;
  const wildcard = `${name}/*`;
  if (allow.some((ref) => String(ref).toLowerCase() === wildcard.toLowerCase())) return [...allow];
  return [...allow, wildcard];
}

function buildAgentPolicyPatches(entries = {}, name) {
  const patches = {};
  for (const [agentId, entry] of Object.entries(entries || {})) {
    const allow = entry?.modelPolicy?.allow;
    if (!Array.isArray(allow) || allow.length === 0) continue;
    const next = buildModelPolicyWithProvider(entry, name);
    if (next && JSON.stringify(next) !== JSON.stringify(allow)) patches[agentId] = { modelPolicy: { allow: next } };
  }
  return patches;
}

function buildAgentsPatch(defaultsPatch, name) {
  const agentsPatch = { defaults: defaultsPatch };
  const entries = buildAgentPolicyPatches(cfg.agents?.entries, name);
  if (Object.keys(entries).length) agentsPatch.entries = entries;
  return agentsPatch;
}

// 幂等重试只补齐目录和显式白名单，不覆盖已有 Provider 的 URL、密钥或模型列表。
if (cfg.models.providers[providerName]) {
  const defaultsPatch = { models: { [`${providerName}/*`]: {} } };
  const modelPolicyAllow = buildModelPolicyWithProvider(cfg.agents.defaults, providerName);
  if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
  const patchRes = runConfigPatch({ agents: buildAgentsPatch(defaultsPatch, providerName) });
  if (patchRes.status !== 0) {
    console.error('Failed to repair existing provider config');
    if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
    if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
    process.exit(patchRes.status || 4);
  }
  if (!displayNames[providerName]) {
    displayNames[providerName] = providerDisplayName;
    writeJson(DISPLAY_NAMES, displayNames);
  }
  console.log(`Provider already exists: ${providerName}`);
  console.log('幂等模式:已补齐模型目录与显式模型白名单。');
  process.exit(0);
}

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
const modelPolicyAllow = buildModelPolicyWithProvider(cfg.agents.defaults, providerName);
const defaultsPatch = { models: modelsPatch };
if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };

console.error('正在写入配置，请稍等...');
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
  agents: buildAgentsPatch(defaultsPatch, providerName),
});
if (patchRes.status !== 0) {
  console.error('Failed to apply config patch');
  if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
  if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
  process.exit(patchRes.status || 4);
}

displayNames[providerName] = providerDisplayName;
writeJson(DISPLAY_NAMES, displayNames);

console.log(`Added provider ${providerName}`);
console.log(`Display name: ${providerDisplayName}`);
console.log(`Config: ${CONFIG}`);
console.log(`Base URL: ${baseUrl}`);
console.log(`Models fetched: ${ids.length}`);
console.log('Sample models:');
for (const id of ids.slice(0, 20)) console.log(`- ${providerName}/${id}`);
