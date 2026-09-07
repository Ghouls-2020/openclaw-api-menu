#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const rawArgs = process.argv.slice(2);
const [action, providerInput, providerDisplayName] = rawArgs;
if (!action || !providerInput || !['check','sync','remove','rename'].includes(action)) {
  console.error('Usage: node provider-manage.mjs <check|sync|remove|rename> <providerNameOrDisplayName> [providerDisplayName]');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
const CONFIG = path.join(STATE_DIR, 'openclaw.json');
const DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');
const FETCH_TIMEOUT_MS = 8000;
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

function runConfigPatch(patch, extraArgs = []) {
  return spawnSync('openclaw', ['config', 'patch', ...extraArgs, '--stdin'], {
    input: JSON.stringify(patch, null, 2),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (err) {
  console.error(`OpenClaw 配置文件损坏或无法解析: ${CONFIG}`);
  process.exit(1);
}
if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

function getExplicitModelPolicyAllow(defaults = cfg.agents.defaults) {
  const allow = defaults?.modelPolicy?.allow;
  return Array.isArray(allow) && allow.length > 0 ? allow : null;
}

function addProviderToModelPolicy(defaults, name) {
  const allow = getExplicitModelPolicyAllow(defaults);
  if (!allow) return null;
  const wildcard = `${name}/*`;
  return allow.some((ref) => String(ref).toLowerCase() === wildcard.toLowerCase())
    ? [...allow]
    : [...allow, wildcard];
}

function removeProviderFromModelPolicy(defaults, name) {
  const allow = getExplicitModelPolicyAllow(defaults);
  if (!allow) return null;
  return allow.filter((ref) => !isProviderRef(ref, name));
}

const providers = cfg.models.providers || {};
const modelMap = cfg.agents.defaults.models || {};
const displayNames = ensureJsonFile(DISPLAY_NAMES, {});

function inferProviderDisplayNameForResolve(provider, fallback = '') {
  if (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string') {
    const inferred = String(provider.models[0].name).split(' / ')[0].trim();
    if (inferred) return inferred;
  }
  return fallback;
}

function resolveProviderKey(input) {
  if (providers[input]) return input;
  const lowered = String(input).toLowerCase();
  for (const key of Object.keys(providers)) {
    if (key.toLowerCase() === lowered) return key;
  }
  for (const [key, value] of Object.entries(displayNames)) {
    if (String(value).toLowerCase() === lowered && providers[key]) return key;
  }
  for (const [key, providerItem] of Object.entries(providers)) {
    const inferred = inferProviderDisplayNameForResolve(providerItem, key);
    if (String(inferred).toLowerCase() === lowered) return key;
  }
  return null;
}

function isValidProviderId(value) {
  return /^[a-zA-Z0-9_-]+$/.test(String(value || ''));
}

function refuseInvalidProviderId(name) {
  if (isValidProviderId(name)) return;
  console.error(`Provider id 非法: ${name}`);
  console.error('当前脚本不会对包含点号(.)、斜杠(/)等字符的旧 provider id 执行 check/sync/remove/rename,避免 OpenClaw patch 路径或模型引用解析错位。');
  console.error('请先手动迁移/改名为只包含字母、数字、下划线(_)和短横线(-)的 provider id。');
  process.exit(6);
}

const providerName = resolveProviderKey(providerInput);
const provider = providerName ? providers[providerName] : null;
if (providerName) refuseInvalidProviderId(providerName);

function refsFor(name) {
  return Object.keys(modelMap).filter(k => k.split('/')[0].toLowerCase() === name.toLowerCase());
}

function isProviderRef(ref, name) {
  return typeof ref === 'string' && ref.split('/')[0]?.toLowerCase() === name.toLowerCase();
}

function rewriteProviderRef(ref, oldName, newName) {
  if (!isProviderRef(ref, oldName)) return ref;
  const slash = String(ref).indexOf('/');
  return `${newName}/${String(ref).slice(slash + 1)}`;
}

function getPrimaryRef(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? value.primary : '';
}

function buildDefaultSelectionPatch(defaults = {}, previousDefaults = null) {
  const patch = {};
  for (const field of ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel', 'utilityModel', 'mediaModels']) {
    if (Object.prototype.hasOwnProperty.call(defaults, field)) {
      patch[field] = defaults[field];
    } else if (previousDefaults && Object.prototype.hasOwnProperty.call(previousDefaults, field)) {
      patch[field] = null;
    }
  }
  return patch;
}

function rewriteRefsDeep(value, oldName, newName = '', remove = false) {
  if (typeof value === 'string') {
    if (!isProviderRef(value, oldName)) return value;
    return remove ? null : rewriteProviderRef(value, oldName, newName);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteRefsDeep(item, oldName, newName, remove)).filter((item) => item !== null);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const keyMatches = isProviderRef(key, oldName);
    if (remove && keyMatches) continue;
    const nextKey = keyMatches ? rewriteProviderRef(key, oldName, newName) : key;
    const next = rewriteRefsDeep(item, oldName, newName, remove);
    if (next !== null) result[nextKey] = next;
  }
  return result;
}

function buildAgentEntriesPatch(entries = {}, oldName, newName = '', remove = false) {
  const patch = {};
  for (const [agentId, entry] of Object.entries(entries || {})) {
    const next = rewriteRefsDeep(entry, oldName, newName, remove);
    if (JSON.stringify(next) !== JSON.stringify(entry)) patch[agentId] = next;
  }
  return patch;
}

function repairModelSelectionForSyncedProvider(config, providerName, validModelIds = []) {
  let defaults; try { defaults = JSON.parse(JSON.stringify(config.agents?.defaults || {})); } catch { return { changed: false, messages: ['序列化配置失败，跳过修复。'], _nextDefaults: config.agents?.defaults || {} }; }
  if (!defaults || Object.keys(defaults).length === 0) return { changed: false, messages: [], _nextDefaults: config.agents?.defaults || {} };
  const validRefs = new Set(validModelIds.map((id) => `${providerName}/${id}`));
  const fallbackRef = validModelIds.length ? `${providerName}/${validModelIds[0]}` : '';
  const messages = [];
  let changed = false;

  const isSameProviderRef = (ref) => typeof ref === 'string' && ref.split('/')[0]?.toLowerCase() === providerName.toLowerCase();
  const isValidSyncedRef = (ref) => isSameProviderRef(ref) && validRefs.has(ref);
  const isInvalidSyncedRef = (ref) => isSameProviderRef(ref) && !validRefs.has(ref);
  const firstValidFallback = (fallbacks = []) => Array.isArray(fallbacks) ? fallbacks.find((ref) => isValidSyncedRef(ref)) : '';

  const repairString = (fieldName) => {
    const value = defaults[fieldName];
    if (!isInvalidSyncedRef(value)) return;
    if (fallbackRef) {
      defaults[fieldName] = fallbackRef;
      messages.push(`${fieldName}: ${value} -> ${fallbackRef}`);
    } else {
      delete defaults[fieldName];
      messages.push(`${fieldName}: 已清理失效引用 ${value}`);
    }
    changed = true;
  };

  const repairObject = (fieldName) => {
    const value = defaults[fieldName];
    if (!value || typeof value !== 'object') return;
    let promotedFallback = '';
    if (isInvalidSyncedRef(value.primary)) {
      const old = value.primary;
      promotedFallback = firstValidFallback(value.fallbacks);
      const nextPrimary = promotedFallback || fallbackRef;
      if (nextPrimary) value.primary = nextPrimary;
      else delete value.primary;
      messages.push(`${fieldName}.primary: ${old}${nextPrimary ? ` -> ${nextPrimary}` : ' 已清理'}`);
      changed = true;
    }
    if (Array.isArray(value.fallbacks)) {
      const before = value.fallbacks.length;
      value.fallbacks = value.fallbacks.filter((ref) => ref !== promotedFallback && !isInvalidSyncedRef(ref));
      if (value.fallbacks.length !== before) {
        messages.push(`${fieldName}.fallbacks: 已清理 ${before - value.fallbacks.length} 个失效或已提升引用`);
        changed = true;
      }
    }
    if (!value.primary && (!Array.isArray(value.fallbacks) || value.fallbacks.length === 0)) {
      delete defaults[fieldName];
      changed = true;
    }
  };

  for (const field of ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel', 'utilityModel']) {
    repairString(field);
    repairObject(field);
  }
  return { changed, messages, _nextDefaults: defaults };
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
      const hadPrimary = !!value.primary;
      if (isProviderRef(value.primary, name)) delete value.primary;
      if (Array.isArray(value.fallbacks)) {
        value.fallbacks = value.fallbacks.filter((ref) => !isProviderRef(ref, name));
      }
      if (hadPrimary && !value.primary && Array.isArray(value.fallbacks) && value.fallbacks.length > 0) {
        value.primary = value.fallbacks[0];
        value.fallbacks = value.fallbacks.slice(1);
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
  pruneSelectionField('utilityModel');
  if (defaults.mediaModels !== undefined) {
    const nextMediaModels = rewriteRefsDeep(defaults.mediaModels, name, '', true);
    if (nextMediaModels && Object.keys(nextMediaModels).length) defaults.mediaModels = nextMediaModels;
    else delete defaults.mediaModels;
  }
}

function guessInputCaps(id) {
  return /(vision|vl|image|4o|gemini|gpt-4\.1|o4)/i.test(id) ? ['text', 'image'] : ['text'];
}
function guessReasoning(id) {
  // 图像/音频/视频类模型不产出思考内容,标记为 reasoner 会让上游收到它不认的
  // reasoning 参数(OpenClaw 自己在图像重试时也会剥掉),故一律不写。
  const s = String(id).toLowerCase();
  return !/(image|imagine|tts|whisper|audio|music|voice)/.test(s);
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

// 同步时由脚本重建的字段;其余字段(params/headers/compat/thinkingLevelMap 等)
// 视为手工维护,原样保留。
const MANAGED_MODEL_FIELDS = new Set(['id', 'name', 'input', 'reasoning', 'cost', 'contextWindow', 'maxTokens']);

function mergeModel(displayName, id, prev, raw = null) {
  const fresh = normalizeModel(displayName, id, raw);
  if (!prev || typeof prev !== 'object') return fresh;
  const preserved = {};
  for (const [key, value] of Object.entries(prev)) {
    if (!MANAGED_MODEL_FIELDS.has(key)) preserved[key] = value;
  }
  const result = { ...fresh, ...preserved };
  // reasoning 是用户的显式选择(v0.1.5:让服务商下所有模型走思考),旧值优先,没有才按 id 猜,
  // 避免同步把手工关掉的模型又打开。
  if (typeof prev.reasoning === 'boolean') result.reasoning = prev.reasoning;
  // 上游没给上限时,保留手工填过的真实值,但丢掉历史上写死的 1M / 128K 占位值。
  if (result.contextWindow === undefined && prev.contextWindow && prev.contextWindow !== FABRICATED_CONTEXT_WINDOW) {
    result.contextWindow = prev.contextWindow;
  }
  if (result.maxTokens === undefined && prev.maxTokens && prev.maxTokens !== FABRICATED_MAX_TOKENS) {
    result.maxTokens = prev.maxTokens;
  }
  // cost 不由脚本编造;手工填过的非全零成本保留,历史上写死的全零成本丢掉。
  if (prev.cost && !isFabricatedCost(prev.cost)) result.cost = prev.cost;
  return result;
}

function buildPrevModelMap(models) {
  return new Map((Array.isArray(models) ? models : []).map((m) => [m?.id, m]).filter(([id]) => id));
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



function getProviderDisplayName(name) {
  return displayNames[name] || inferProviderDisplayName(providers[name], name);
}

function inferProviderDisplayName(provider, fallback = '') {
  if (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string') {
    const inferred = String(provider.models[0].name).split(' / ')[0].trim();
    if (inferred) return inferred;
  }
  return fallback;
}

function findProviderDisplayNameConflict(name, excludeId = '') {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return null;
  for (const [id, providerItem] of Object.entries(providers || {})) {
    if (id === excludeId) continue;
    const names = new Set();
    if (displayNames[id]) names.add(String(displayNames[id]).trim());
    const inferred = inferProviderDisplayName(providerItem, id);
    if (inferred) names.add(String(inferred).trim());
    for (const candidate of names) {
      if (candidate && candidate.toLowerCase() === text) return { id, name: candidate };
    }
  }
  return null;
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
  const policyRefs = (getExplicitModelPolicyAllow() || []).filter((ref) => isProviderRef(ref, providerName));
  console.log(`agents.defaults.models refs: ${refs.length}`);
  console.log(`agents.defaults.modelPolicy.allow refs: ${policyRefs.length}`);
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
  const conflict = findProviderDisplayNameConflict(providerDisplayName, providerName);
  if (conflict) {
    console.error(`Display name already exists: ${providerDisplayName} (${conflict.id})`);
    process.exit(3);
  }
  displayNames[providerName] = providerDisplayName;
  if (Array.isArray(provider.models)) {
    provider.models = provider.models.map((model) => ({
      ...model,
      name: `${providerDisplayName} / ${model.id}`,
    }));
  }
  console.error('正在写入配置，请稍等...');
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
  writeJson(DISPLAY_NAMES, displayNames);
  console.log(`Renamed provider display: ${providerName} -> ${providerDisplayName}`);
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
  for (const [agentId, entry] of Object.entries(cfg.agents?.entries || {})) {
    const agentPrimary = getPrimaryRef(entry?.model);
    if (isProviderRef(agentPrimary, providerName)) {
      console.error(`Refusing to remove ${providerName}: agent ${agentId} is still using it (${agentPrimary})`);
      process.exit(3);
    }
  }
  let previousDefaults; try { previousDefaults = JSON.parse(JSON.stringify(cfg.agents?.defaults || {})); } catch { console.error('配置序列化失败，无法继续。'); process.exit(1); }
  delete cfg.models.providers[providerName];
  delete displayNames[providerName];
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
  const modelPolicyAllow = removeProviderFromModelPolicy(previousDefaults, providerName);
  const defaultsPatch = {
    ...buildDefaultSelectionPatch(cfg.agents?.defaults || {}, previousDefaults),
    models: modelRefPatch,
  };
  if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
  const agentEntriesPatch = buildAgentEntriesPatch(cfg.agents?.entries, providerName, '', true);
  const agentsPatch = { defaults: defaultsPatch };
  if (Object.keys(agentEntriesPatch).length) agentsPatch.entries = agentEntriesPatch;
  console.error('正在写入配置，请稍等...');
  const patchRes = runConfigPatch({
    models: {
      providers: {
        [providerName]: null,
      },
    },
    agents: agentsPatch,
  });
  if (patchRes.status !== 0) {
    console.error('Failed to apply config patch');
    if (patchRes.stdout) console.error(String(patchRes.stdout).trim());
    if (patchRes.stderr) console.error(String(patchRes.stderr).trim());
    process.exit(patchRes.status || 4);
  }
  writeJson(DISPLAY_NAMES, displayNames);
  console.log(`Removed provider: ${providerName}`);
  console.log(`Removed refs: ${removed}`);
  process.exit(0);
}

async function fetchGatewayProviderModelIds(providerId) {
  const result = spawnSync('openclaw', ['gateway', 'call', 'models.list', '--params', JSON.stringify({ view: 'configured', refresh: true }), '--json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Gateway models.list 调用失败').trim());
  const data = JSON.parse(String(result.stdout || '').trim() || '{}');
  const ids = [...new Set((Array.isArray(data?.models) ? data.models : [])
    .filter((item) => String(item?.provider || '').toLowerCase() === String(providerId || '').toLowerCase())
    .map((item) => item?.id).filter(Boolean))];
  if (!ids.length) throw new Error(`Gateway 未返回 Provider ${providerId} 的模型`);
  return ids;
}

function repairAgentEntriesForSyncedProvider(entries = {}, providerName, validModelIds = []) {
  const repaired = {};
  for (const [agentId, entry] of Object.entries(entries || {})) {
    const result = repairModelSelectionForSyncedProvider({ agents: { defaults: entry } }, providerName, validModelIds);
    if (result.changed) repaired[agentId] = result._nextDefaults;
  }
  return repaired;
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
  if (provider.apiKey && typeof provider.apiKey === 'object') {
    let ids;
    try { ids = await fetchGatewayProviderModelIds(providerName); }
    catch (err) { console.error(String(err?.message || 'Gateway models.list 调用失败')); process.exit(4); }
    let previousDefaults; try { previousDefaults = JSON.parse(JSON.stringify(cfg.agents?.defaults || {})); } catch { console.error('配置序列化失败，无法继续。'); process.exit(1); }
    const displayName = getProviderDisplayName(providerName);
    const prevModels = buildPrevModelMap(provider.models);
    // Gateway 的 models.list 只是回显本地配置,拿不到上游真实规格,所以不传 raw:
    // 上下文/输出上限交给 mergeModel 的"保留手工值、丢弃写死占位值"规则处理。
    provider.models = ids.map(id => mergeModel(displayName, id, prevModels.get(id), null));
    const addedModels = ids.filter(id => !prevModels.has(id)).length;
    const removedModels = [...prevModels.keys()].filter(id => !ids.includes(id)).length;
    const modelRefPatch = clearProviderModelRefs(modelMap, providerName);
    const repairedDefaults = repairModelSelectionForSyncedProvider({ agents: { defaults: cfg.agents?.defaults } }, providerName, ids);
    const defaultsPatch = buildDefaultSelectionPatch(repairedDefaults.changed ? repairedDefaults._nextDefaults : (cfg.agents?.defaults || {}), previousDefaults);
    const modelPolicyAllow = addProviderToModelPolicy(previousDefaults, providerName);
    if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
    const repairedEntries = repairAgentEntriesForSyncedProvider(cfg.agents?.entries, providerName, ids);
    if (Object.keys(modelRefPatch).length) defaultsPatch.models = modelRefPatch;
    const patch = { models: { providers: { [providerName]: provider } }, agents: { defaults: defaultsPatch } };
    if (Object.keys(repairedEntries).length) patch.agents.entries = repairedEntries;
    const patchRes = runConfigPatch(patch, ['--replace-path', `models.providers.${providerName}.models`]);
    if (patchRes.status !== 0) { console.error('Failed to apply config patch'); if (patchRes.stdout) console.error(String(patchRes.stdout).trim()); if (patchRes.stderr) console.error(String(patchRes.stderr).trim()); process.exit(patchRes.status || 4); }
    console.log(`Synced provider: ${providerName}`);
    console.log(`Models now present: ${ids.length}`);
    console.log(`Added models: ${addedModels}`);
    console.log(`Removed models: ${removedModels}`);
    process.exit(0);
  }
  const modelsUrl = (() => {
    const u = new URL(baseUrl);
    const cleanPath = u.pathname.replace(/\/+$/, '');
    return /\/v1$/.test(cleanPath) ? `${u.origin}${cleanPath}/models` : `${u.origin}${cleanPath}/v1/models`;
  })();
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
  let data;
  try { data = await res.json(); } catch { console.error('Failed to parse /models response as JSON (可能被网关返回了 HTML 错误页)'); process.exit(4); }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];
  if (!ids.length) {
    console.error('No model IDs found in /models response');
    process.exit(5);
  }
  let previousDefaults; try { previousDefaults = JSON.parse(JSON.stringify(cfg.agents?.defaults || {})); } catch { console.error('配置序列化失败，无法继续。'); process.exit(1); }
  const displayName = getProviderDisplayName(providerName);
  const prevModels = buildPrevModelMap(provider.models);
  // 保留 /models 原始行,mergeModel 要从里面取真实的上下文/输出上限。
  const rawById = new Map();
  for (const row of rows) {
    const rowId = row?.id;
    if (rowId && !rawById.has(rowId)) rawById.set(rowId, row);
  }
  provider.models = ids.map(id => mergeModel(displayName, id, prevModels.get(id), rawById.get(id)));
  const added = ids.filter(id => !prevModels.has(id)).length;
  const removed = [...prevModels.keys()].filter(id => !ids.includes(id)).length;
  const modelRefPatch = clearProviderModelRefs(modelMap, providerName);
  const repairedDefaults = repairModelSelectionForSyncedProvider({ agents: { defaults: cfg.agents?.defaults } }, providerName, ids);
  const defaultsPatch = buildDefaultSelectionPatch(
    repairedDefaults.changed ? repairedDefaults._nextDefaults : (cfg.agents?.defaults || {}),
    previousDefaults
  );
  const modelPolicyAllow = addProviderToModelPolicy(previousDefaults, providerName);
  if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
  if (Object.keys(modelRefPatch).length) defaultsPatch.models = modelRefPatch;
  const repairedEntries = repairAgentEntriesForSyncedProvider(cfg.agents?.entries, providerName, ids);
  console.error('正在写入配置，请稍等...');
  const patchRes = runConfigPatch({
    models: {
      providers: {
        [providerName]: provider,
      },
    },
    agents: {
      defaults: defaultsPatch,
      ...(Object.keys(repairedEntries).length ? { entries: repairedEntries } : {}),
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
  console.log(`Added models: ${added}`);
  console.log(`Removed models: ${removed}`);
  if (repairedDefaults.changed) {
    console.log('Repaired default model refs:');
    for (const msg of repairedDefaults.messages) console.log(`- ${msg}`);
  }
}
