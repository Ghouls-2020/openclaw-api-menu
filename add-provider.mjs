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
const modelsUrl = (() => {
  const u = new URL(baseUrl);
  const cleanPath = u.pathname.replace(/\/+$/, '');
  return /\/v1$/.test(cleanPath) ? `${u.origin}${cleanPath}/models` : `${u.origin}${cleanPath}/v1/models`;
})();

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
    // JSON 解析失败:备份成 .corrupt- 后重置,不要再往下走 .invalid- 分支,
    // 否则同一次损坏会同时留下 .corrupt- 和 .invalid- 两份一模一样的备份。
    const corruptPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, corruptPath, fs.constants.COPYFILE_EXCL); } catch {}
    atomicWriteJsonFile(file, fallback);
    return structuredClone(fallback);
  }
  // 能解析但结构不对(比如该是对象却是数组):另存成 .invalid- 再重置。
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


function guessReasoning(id) {
  // 图像/音频/视频类模型不产出思考内容,标记为 reasoner 会让上游收到它不认的
  // reasoning 参数(OpenClaw 自己在图像重试时也会剥掉),故一律不写。
  const s = String(id).toLowerCase();
  return !/(image|imagine|tts|whisper|audio|music|voice)/.test(s);
}

// agents.defaults.models 只是元数据/别名覆盖表,不影响模型可用性(可用性由
// models.providers 与 modelPolicy.allow 决定)。同步不再往里写引用,并清掉本
// provider 遗留的空对象引用;带实际内容的条目(如 alias)保留。
function clearProviderModelRefs(modelMap, providerName) {
  const patch = {};
  const prefix = String(providerName).toLowerCase();
  for (const [ref, value] of Object.entries(modelMap || {})) {
    if (String(ref).split('/')[0]?.toLowerCase() !== prefix) continue;
    const isEmptyObject = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    if (isEmptyObject) patch[ref] = null;
  }
  return patch;
}


// ===== ocapi:model-meta 开始(三个脚本保持一致,改一处必须同步改另外两处)=====
// 历史上这里写死 contextWindow=1M / maxTokens=128K / cost 全 0,等于给每个模型编了一份
// 假规格:OpenClaw 按这些值决定历史裁剪和请求上限,写死大数会让超长请求直接被上游 400,
// 成本恒 0 会让用量统计永远是 0。现在改成只写 /models 真给了的值,给不出就不写,
// 让 OpenClaw 用它自己的默认值。
const FABRICATED_CONTEXT_WINDOW = 1048576;
const FABRICATED_MAX_TOKENS = 128000;

function pickFirstPositiveInt(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return null;
}

// 从 /models 原始行里取真实上下文/输出上限;各家字段名不统一,按常见口径挨个试。
function extractModelLimits(raw) {
  if (!raw || typeof raw !== 'object') return { contextWindow: null, maxTokens: null };
  const top = raw.top_provider && typeof raw.top_provider === 'object' ? raw.top_provider : {};
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  return {
    contextWindow: pickFirstPositiveInt(
      raw.context_length, raw.contextWindow, raw.context_window,
      raw.max_context_length, raw.max_input_tokens, raw.max_context_tokens,
      top.context_length, meta.context_length,
    ),
    maxTokens: pickFirstPositiveInt(
      raw.max_output_tokens, raw.maxTokens, raw.max_tokens,
      raw.max_completion_tokens, top.max_completion_tokens, meta.max_output_tokens,
    ),
  };
}

// pricing 各家口径不一(每 token / 每千 token / 每百万 token,还有字符串和不同币种),
// 猜错比不写更糟,所以脚本一律不再写 cost。
function isFabricatedCost(cost) {
  if (!cost || typeof cost !== 'object') return false;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => Number(cost[key]) === 0);
}

function normalizeModel(displayName, id, raw = null) {
  const model = {
    id,
    name: `${displayName} / ${id}`,
    input: guessInputCaps(id),
    reasoning: guessReasoning(id), // 文本模型走思考(reasoner);图像/音频类不写
  };
  const { contextWindow, maxTokens } = extractModelLimits(raw);
  if (contextWindow) model.contextWindow = contextWindow;
  if (maxTokens) model.maxTokens = maxTokens;
  return model;
}
// ===== ocapi:model-meta 结束 =====

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
  // 5 = 输入校验失败,与网络类失败(2)区分,调用方据此决定是否重试。
  process.exit(5);
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
  const defaultsPatch = {};
  const staleRefs = clearProviderModelRefs(cfg.agents?.defaults?.models, providerName);
  if (Object.keys(staleRefs).length) defaultsPatch.models = staleRefs;
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

let data;
try { data = await res.json(); } catch { console.error('Failed to parse /models response as JSON (可能被网关返回了 HTML 错误页)'); process.exit(2); }
const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
const ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];
if (!ids.length) {
  console.error('No model IDs found in /models response');
  process.exit(3);
}

// 保留 /models 原始行,normalizeModel 要从里面取真实的上下文/输出上限。
const rawById = new Map();
for (const row of rows) {
  const rowId = row?.id;
  if (rowId && !rawById.has(rowId)) rawById.set(rowId, row);
}
const providerModels = ids.map(id => normalizeModel(providerDisplayName, id, rawById.get(id)));
const modelPolicyAllow = buildModelPolicyWithProvider(cfg.agents.defaults, providerName);
const defaultsPatch = {};
const staleModelRefs = clearProviderModelRefs(cfg.agents?.defaults?.models, providerName);
if (Object.keys(staleModelRefs).length) defaultsPatch.models = staleModelRefs;
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
