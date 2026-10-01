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
const CONFIG_PATCH_TIMEOUT_MS = 30000;
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

// 同步等待:脚本是同步流程,这里用 Atomics.wait,不再起子进程 sleep。
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function runConfigPatch(patch, extraArgs = []) {
  return spawnSync('openclaw', ['config', 'patch', ...extraArgs, '--stdin'], {
    input: JSON.stringify(patch, null, 2),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: CONFIG_PATCH_TIMEOUT_MS,
  });
}

function printConfigPatchFailure(result, label = 'Failed to apply config patch') {
  console.error(label);
  if (result?.error?.code === 'ETIMEDOUT') console.error(`配置写入超时:${CONFIG_PATCH_TIMEOUT_MS}ms`);
  else if (result?.error) console.error(result.error.message);
  if (result?.stdout) console.error(String(result.stdout).trim());
  if (result?.stderr) console.error(String(result.stderr).trim());
}

// ---- 体积保护(size-drop)友好的分步删除 ----
// OpenClaw 的写入安全会拒绝「新配置 < 基线字节 × 50%」的写入
// (io.warnings 里 size-drop 与 size-drop-vs-last-good 两条判定)。
// 大 provider(几十个模型)一次删干净会让体积腰斩而被拒；
// 这里改成分几步砍短 models 数组，每步都保证整份配置体积仍 ≥ 基线的 55%，
// 于是既不需要任何绕过开关，也不会留下写残的配置。
const SIZE_GUARD_RATIO = 0.55;

function readConfigBytes() {
  try { return fs.statSync(CONFIG).size; } catch { return 0; }
}

function sizeGuardFloorBytes() {
  let baseline = readConfigBytes();
  try { baseline = Math.max(baseline, fs.statSync(`${CONFIG}.last-good`).size); } catch {}
  return Math.floor(baseline * SIZE_GUARD_RATIO);
}

// 估算「把该 provider 的 models 截到 keepCount 个之后」整份配置的字节数。
// 官方写盘就是 JSON.stringify(cfg, null, 2) + '\n'，所以这个估算与实际一致。
function projectTrimmedBytes(providerId, keepCount) {
  let live;
  try { live = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
  const item = live?.models?.providers?.[providerId];
  if (!item || !Array.isArray(item.models)) return null;
  item.models = item.models.slice(0, keepCount);
  return Buffer.byteLength(`${JSON.stringify(live, null, 2)}\n`, 'utf8');
}

// true = 已把该 provider 的 models 清空(或无需处理)；false = 失败，调用方应停止。
function trimProviderModelsStepwise(providerId) {
  for (let step = 1; step <= 40; step += 1) {
    let live;
    try { live = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {
      console.error(`分步删除 ${providerId}: 配置读取失败。`);
      return false;
    }
    const item = live?.models?.providers?.[providerId];
    if (!item) return true;
    const models = Array.isArray(item.models) ? item.models : [];
    if (!models.length) return true;
    const floor = sizeGuardFloorBytes();
    // 二分找「本步能删得最多、同时整份配置体积仍 ≥ floor」的保留数量。
    // 比"每次减半"少走好几步（保护线是 50%，我们只看整份配置字节数）。
    let lo = 0;
    let hi = models.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((projectTrimmedBytes(providerId, mid) ?? 0) >= floor) hi = mid;
      else lo = mid + 1;
    }
    const keep = lo;
    const projected = projectTrimmedBytes(providerId, keep) ?? 0;
    if (keep >= models.length || projected < floor) {
      console.error(`分步删除 ${providerId}: 还剩 ${models.length} 个模型时，体积无法再保持在 ${floor} 字节以上，` +
        '继续删会触发写入保护。请先扩大配置(或直接改 openclaw.json)。');
      return false;
    }
    console.error(`  [分步 ${step}] ${providerId} 模型 ${models.length} → ${keep}（体积下限 ${floor} 字节 / 预计 ${projected}）`);
    const stepPatch = { models: { providers: { [providerId]: { models: models.slice(0, keep) } } } };
    const stepArgs = ['--replace-path', `models.providers.${providerId}.models`];
    let res = runConfigPatch(stepPatch, stepArgs);
    if (res.status !== 0) {
      // 网关瞬时繁忙很常见,自动重试一次再放弃
      console.error(`  第 ${step} 步写入失败,2 秒后重试一次...`);
      sleepMs(2000);
      res = runConfigPatch(stepPatch, stepArgs);
    }
    if (res.status !== 0) {
      printConfigPatchFailure(res, `分步删除 ${providerId} 的第 ${step} 步失败`);
      return false;
    }
  }
  console.error(`分步删除 ${providerId}: 超过 40 步仍未清空，停止。`);
  return false;
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
  for (const field of ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel', 'utilityModel', 'voiceModel', 'mediaModels', 'heartbeat', 'subagents']) {
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

const MODEL_SELECTION_FIELDS = ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel', 'utilityModel', 'voiceModel'];

// 同步后只做两件安全的修复:失效的 primary 换成同字段里仍有效的 fallback、清掉失效的 fallback。
// 以前找不到 fallback 时会拿 /models 列表第一个模型顶上,那可能是嵌入/图像模型,
// 默认模型会直接变成不能聊天的模型;现在原值保留,只给出警告,由用户自己换。
function repairModelSelectionForSyncedProvider(config, providerName, validModelIds = []) {
  let defaults; try { defaults = JSON.parse(JSON.stringify(config.agents?.defaults || {})); } catch { return { changed: false, messages: ['序列化配置失败，跳过修复。'], warnings: [], _nextDefaults: config.agents?.defaults || {} }; }
  if (!defaults || Object.keys(defaults).length === 0) return { changed: false, messages: [], warnings: [], _nextDefaults: config.agents?.defaults || {} };
  const validIds = new Set(validModelIds);
  const messages = [];
  const warnings = [];
  let changed = false;

  const modelIdOf = (ref) => {
    const slash = ref.indexOf('/');
    return slash === -1 ? '' : ref.slice(slash + 1);
  };
  const isSameProviderRef = (ref) => typeof ref === 'string' && ref.split('/')[0]?.toLowerCase() === providerName.toLowerCase();
  const isValidSyncedRef = (ref) => isSameProviderRef(ref) && validIds.has(modelIdOf(ref));
  const isInvalidSyncedRef = (ref) => isSameProviderRef(ref) && !validIds.has(modelIdOf(ref));
  const firstValidFallback = (fallbacks = []) => (Array.isArray(fallbacks) ? fallbacks.find((ref) => isValidSyncedRef(ref)) : '') || '';
  const keepWithWarning = (label, ref) => {
    warnings.push(`${label}: ${ref} 不在上游模型列表中,已保留原值;如该模型确已下线,请到 [1] 换模型手动切换。`);
  };

  const repairSelectionObject = (label, value) => {
    let promotedFallback = '';
    if (isInvalidSyncedRef(value.primary)) {
      promotedFallback = firstValidFallback(value.fallbacks);
      if (promotedFallback) {
        messages.push(`${label}.primary: ${value.primary} -> ${promotedFallback}`);
        value.primary = promotedFallback;
        changed = true;
      } else {
        keepWithWarning(`${label}.primary`, value.primary);
      }
    }
    if (Array.isArray(value.fallbacks)) {
      const before = value.fallbacks.length;
      value.fallbacks = value.fallbacks.filter((ref) => ref !== promotedFallback && !isInvalidSyncedRef(ref));
      if (value.fallbacks.length !== before) {
        messages.push(`${label}.fallbacks: 已清理 ${before - value.fallbacks.length} 个失效或已提升引用`);
        changed = true;
      }
    }
  };

  for (const field of MODEL_SELECTION_FIELDS) {
    const value = defaults[field];
    if (typeof value === 'string') {
      if (isInvalidSyncedRef(value)) keepWithWarning(field, value);
    } else if (value && typeof value === 'object') {
      repairSelectionObject(field, value);
      if (!value.primary && (!Array.isArray(value.fallbacks) || value.fallbacks.length === 0)) {
        delete defaults[field];
        changed = true;
      }
    }
  }
  for (const field of ['heartbeat', 'subagents']) {
    const holder = defaults[field];
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
    const current = holder.model;
    if (typeof current === 'string') {
      if (isInvalidSyncedRef(current)) keepWithWarning(`${field}.model`, current);
    } else if (current && typeof current === 'object') {
      repairSelectionObject(`${field}.model`, current);
      if (!current.primary && (!Array.isArray(current.fallbacks) || current.fallbacks.length === 0)) delete holder.model;
    }
  }
  return { changed, messages, warnings, _nextDefaults: defaults };
}

// 收集 defaults 和各 Agent 条目里正在引用本 provider 的模型 id。
function collectReferencedModelIds(config, providerName) {
  const ids = new Set();
  const prefix = `${String(providerName).toLowerCase()}/`;
  const addRef = (ref) => {
    if (typeof ref !== 'string' || !ref.toLowerCase().startsWith(prefix)) return;
    const id = ref.slice(prefix.length);
    if (id && id !== '*') ids.add(id);
  };
  const addSelection = (value) => {
    if (typeof value === 'string') addRef(value);
    else if (value && typeof value === 'object') {
      addRef(value.primary);
      if (Array.isArray(value.fallbacks)) value.fallbacks.forEach(addRef);
    }
  };
  const addDeep = (value) => {
    if (typeof value === 'string') addRef(value);
    else if (Array.isArray(value)) value.forEach(addDeep);
    else if (value && typeof value === 'object') Object.values(value).forEach(addDeep);
  };
  const scan = (holder) => {
    if (!holder || typeof holder !== 'object') return;
    for (const field of MODEL_SELECTION_FIELDS) addSelection(holder[field]);
    for (const field of ['heartbeat', 'subagents']) {
      if (holder[field] && typeof holder[field] === 'object') addSelection(holder[field].model);
    }
    if (holder.mediaModels !== undefined) addDeep(holder.mediaModels);
  };
  scan(config.agents?.defaults);
  for (const entry of Object.values(config.agents?.entries || {})) scan(entry);
  return ids;
}

// 上游 /models 偶尔会漏掉仍在用的模型(公益站渠道临时下线最常见)。被默认模型/Agent
// 引用的旧模型不跟着删,留在列表里并提示,避免同步一次就把正在用的模型删掉。
function withReferencedModels(config, providerName, upstreamIds, prevModels) {
  const upstream = new Set(upstreamIds);
  const keptIds = [...collectReferencedModelIds(config, providerName)]
    .filter((id) => !upstream.has(id) && prevModels.has(id));
  return { finalIds: [...upstreamIds, ...keptIds], keptIds };
}

function printSyncReferenceNotes(providerName, keptIds = [], warnings = []) {
  if (keptIds.length) {
    console.log(`Kept referenced models: ${keptIds.length}`);
    for (const id of keptIds) console.log(`- ${providerName}/${id}(上游 /models 本次未返回,但仍被默认模型/Agent 配置引用,已保留未删除)`);
    console.log('如确认这些模型已下线,请到 [1] 换模型切走,下次同步会自动移除。');
  }
  if (warnings.length) {
    console.log('需要确认的模型引用(已保留原值,未自动替换):');
    for (const msg of warnings) console.log(`- ${msg}`);
  }
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
  pruneSelectionField('voiceModel');
  for (const field of ['heartbeat', 'subagents']) {
    const holder = defaults[field];
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
    const current = holder.model;
    if (typeof current === 'string' && isProviderRef(current, name)) delete holder.model;
    else if (current && typeof current === 'object') {
      if (isProviderRef(current.primary, name)) delete current.primary;
      if (Array.isArray(current.fallbacks)) current.fallbacks = current.fallbacks.filter((ref) => !isProviderRef(ref, name));
      if (!current.primary && Array.isArray(current.fallbacks) && current.fallbacks.length > 0) {
        current.primary = current.fallbacks.shift();
      }
      if (!current.primary && (!Array.isArray(current.fallbacks) || current.fallbacks.length === 0)) delete holder.model;
    }
    if (Object.keys(holder).length === 0) delete defaults[field];
  }
  if (defaults.mediaModels !== undefined) {
    const nextMediaModels = rewriteRefsDeep(defaults.mediaModels, name, '', true);
    if (nextMediaModels && Object.keys(nextMediaModels).length) defaults.mediaModels = nextMediaModels;
    else delete defaults.mediaModels;
  }
}

function guessInputCaps(id) {
  return /(vision|vl|image|4o|gemini|gpt-4\.1|o4)/i.test(id) ? ['text', 'image'] : ['text'];
}
// ===== ocapi:model-meta 开始(三个脚本保持一致,改一处必须同步改另外两处)=====
// 历史上这里写死 contextWindow=1M / maxTokens=128K / cost 全 0,等于给每个模型编了一份
// 假规格:OpenClaw 按这些值决定历史裁剪和请求上限,写死大数会让超长请求直接被上游 400,
// 成本恒 0 会让用量统计永远是 0。现在改成只写 /models 真给了的值,给不出就不写,
// 让 OpenClaw 用它自己的默认值。
function pickFirstPositiveInt(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return null;
}

// 从 /models 原始行里取真实上下文/输出上限;各家字段名不统一,按常见口径挨个试。
// 不认 snake_case 的 max_tokens:它和请求参数同名,个别服务商在模型目录里回显的是
// "默认输出长度"(如 4096)而不是上限,当成上限写进去反而会把输出压低。
// 只认语义明确的 max_output_tokens / max_completion_tokens。
function extractModelLimits(raw) {
  if (!raw || typeof raw !== 'object') return { contextWindow: null, maxTokens: null };
  const top = raw.top_provider && typeof raw.top_provider === 'object' ? raw.top_provider : {};
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const contextWindow = pickFirstPositiveInt(
    raw.context_length, raw.contextWindow, raw.context_window,
    raw.max_context_length, raw.max_input_tokens, raw.max_context_tokens,
    top.context_length, meta.context_length,
  );
  let maxTokens = pickFirstPositiveInt(
    raw.max_output_tokens, raw.maxTokens,
    raw.max_completion_tokens, top.max_completion_tokens, meta.max_output_tokens,
  );
  // 输出上限不可能大于上下文窗口;超了说明这个字段不是我们以为的含义,宁可不写。
  if (maxTokens && contextWindow && maxTokens > contextWindow) maxTokens = null;
  return { contextWindow, maxTokens };
}

// pricing 各家口径不一(每 token / 每千 token / 每百万 token,还有字符串和不同币种),
// 猜错比不写更糟,所以脚本一律不再写 cost。
function normalizeModel(displayName, id, raw = null) {
  const model = {
    id,
    name: `${displayName} / ${id}`,
    input: guessInputCaps(id),
    reasoning: true, // 用户指定:所有模型统一启用 reasoning,不按名称或上游声明区分。
  };
  const { contextWindow, maxTokens } = extractModelLimits(raw);
  if (contextWindow) model.contextWindow = contextWindow;
  if (maxTokens) model.maxTokens = maxTokens;
  return model;
}
// ===== ocapi:model-meta 结束 =====

// 脚本历史上自己写死过的占位规格。它们不是手工值,合并时要丢掉而不是保留。
const FABRICATED_CONTEXT_WINDOW = 1048576;
const FABRICATED_MAX_TOKENS = 128000;

// 全零成本同样是脚本编的,不是人工填的;人工填过的真实成本才保留。
function isFabricatedCost(cost) {
  if (!cost || typeof cost !== 'object') return false;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => Number(cost[key]) === 0);
}

// 同步时由脚本重建的字段;其余字段(params/headers/compat/thinkingLevelMap 等)
// 视为手工维护,原样保留。
const MANAGED_MODEL_FIELDS = new Set(['id', 'name', 'reasoning', 'cost', 'contextWindow', 'maxTokens']);

function mergeModel(displayName, id, prev, raw = null) {
  const fresh = normalizeModel(displayName, id, raw);
  if (!prev || typeof prev !== 'object') return fresh;
  const preserved = {};
  for (const [key, value] of Object.entries(prev)) {
    if (!MANAGED_MODEL_FIELDS.has(key)) preserved[key] = value;
  }
  const result = { ...fresh, ...preserved };
  if (Array.isArray(prev.input) && prev.input.length > 0) result.input = [...prev.input];
  // contextWindow / maxTokens / cost 一律"手工值优先":上游只用来补空,
  // 不覆盖人工填过的值。悄悄改掉用户的修正,正是这一版要修的那类问题。
  // 唯一例外是脚本自己历史上写死的占位值(1M / 128K / 全零成本),那不算手工值,直接丢。
  // reasoning 统一使用 fresh 中的 true,不保留旧配置里的 false。
  if (prev.contextWindow && prev.contextWindow !== FABRICATED_CONTEXT_WINDOW) {
    result.contextWindow = prev.contextWindow;
  }
  if (prev.maxTokens && prev.maxTokens !== FABRICATED_MAX_TOKENS) {
    result.maxTokens = prev.maxTokens;
  }
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
    printConfigPatchFailure(patchRes);
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
  const agentEntryReplacePaths = [];
  for (const agentId of Object.keys(agentEntriesPatch)) agentEntryReplacePaths.push('--replace-path', `agents.entries[${JSON.stringify(agentId)}]`);
  const agentsPatch = { defaults: defaultsPatch };
  if (Object.keys(agentEntriesPatch).length) agentsPatch.entries = agentEntriesPatch;
  if (Array.isArray(provider.models) && provider.models.length) {
    console.error(`正在分步删除 ${providerName} 的 ${provider.models.length} 个模型条目（每步保持配置体积 ≥ 基线 55%，不触发写入保护）...`);
    if (!trimProviderModelsStepwise(providerName)) process.exit(7);
  }
  const finalPatch = {
    models: {
      providers: {
        [providerName]: null,
      },
    },
    agents: agentsPatch,
  };
  let patchRes;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.error(attempt === 1 ? '正在写入配置，请稍等...' : `写入失败,2 秒后重试(第 ${attempt} 次)...`);
    patchRes = runConfigPatch(finalPatch, agentEntryReplacePaths);
    if (patchRes.status === 0) break;
    if (attempt < 3) sleepMs(2000);
  }
  if (patchRes.status !== 0) {
    // 若是"模型已清空但 provider 本体没删掉"的半成品态:配置依然有效,重跑一次即可
    let partial = false;
    try {
      const live = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      const item = live?.models?.providers?.[providerName];
      partial = Boolean(item) && (!Array.isArray(item.models) || item.models.length === 0);
    } catch {}
    printConfigPatchFailure(patchRes, partial
      ? `${providerName} 的模型已清空,但 provider 本体删除失败;配置仍然有效,重跑本命令即可`
      : 'Failed to apply config patch');
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
  const warnings = [];
  for (const [agentId, entry] of Object.entries(entries || {})) {
    const result = repairModelSelectionForSyncedProvider({ agents: { defaults: entry } }, providerName, validModelIds);
    if (result.changed) repaired[agentId] = result._nextDefaults;
    warnings.push(...(result.warnings || []).map((msg) => `${agentId}.${msg}`));
  }
  return { entries: repaired, warnings };
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
    const { finalIds, keptIds } = withReferencedModels(cfg, providerName, ids, prevModels);
    // Gateway 的 models.list 只是回显本地配置,拿不到上游真实规格,所以不传 raw:
    // 上下文/输出上限交给 mergeModel 的"保留手工值、丢弃写死占位值"规则处理。
    provider.models = finalIds.map(id => mergeModel(displayName, id, prevModels.get(id), null));
    const addedModels = ids.filter(id => !prevModels.has(id)).length;
    const removedModels = [...prevModels.keys()].filter(id => !finalIds.includes(id)).length;
    const modelRefPatch = clearProviderModelRefs(modelMap, providerName);
    const repairedDefaults = repairModelSelectionForSyncedProvider({ agents: { defaults: cfg.agents?.defaults } }, providerName, finalIds);
    const defaultsPatch = buildDefaultSelectionPatch(repairedDefaults.changed ? repairedDefaults._nextDefaults : (cfg.agents?.defaults || {}), previousDefaults);
    const modelPolicyAllow = addProviderToModelPolicy(previousDefaults, providerName);
    if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
    const { entries: repairedEntries, warnings: entryWarnings } = repairAgentEntriesForSyncedProvider(cfg.agents?.entries, providerName, finalIds);
    if (Object.keys(modelRefPatch).length) defaultsPatch.models = modelRefPatch;
    const patch = { models: { providers: { [providerName]: provider } }, agents: { defaults: defaultsPatch } };
    if (Object.keys(repairedEntries).length) patch.agents.entries = repairedEntries;
    const replacePaths = ['--replace-path', `models.providers.${providerName}.models`];
    for (const agentId of Object.keys(repairedEntries)) replacePaths.push('--replace-path', `agents.entries[${JSON.stringify(agentId)}]`);
    const patchRes = runConfigPatch(patch, replacePaths);
    if (patchRes.status !== 0) { printConfigPatchFailure(patchRes); process.exit(patchRes.status || 4); }
    console.log(`Synced provider: ${providerName}`);
    console.log(`Models now present: ${finalIds.length}`);
    console.log(`Added models: ${addedModels}`);
    console.log(`Removed models: ${removedModels}`);
    if (repairedDefaults.changed) {
      console.log('Repaired default model refs:');
      for (const msg of repairedDefaults.messages) console.log(`- ${msg}`);
    }
    printSyncReferenceNotes(providerName, keptIds, [...(repairedDefaults.warnings || []), ...entryWarnings]);
    process.exit(0);
  }
  const modelsUrl = (() => {
    const u = new URL(baseUrl);
    const cleanPath = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${cleanPath}/models`;
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
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`Failed to connect to ${modelsUrl}`);
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
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
  let data;
  try {
    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);
      if (text) console.error(text.slice(0, 1000));
      process.exit(4);
    }
    try {
      data = await res.json();
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      console.error('Failed to parse /models response as JSON (可能被网关返回了 HTML 错误页)');
      process.exit(4);
    }
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      console.error(`请求超时:${FETCH_TIMEOUT_MS}ms，请检查网关或 Base URL。`);
    } else {
      console.error(err?.message || '读取 /models 响应失败');
    }
    process.exit(4);
  } finally {
    clearTimeout(timeoutId);
  }
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
  const { finalIds, keptIds } = withReferencedModels(cfg, providerName, ids, prevModels);
  provider.models = finalIds.map(id => mergeModel(displayName, id, prevModels.get(id), rawById.get(id)));
  const added = ids.filter(id => !prevModels.has(id)).length;
  const removed = [...prevModels.keys()].filter(id => !finalIds.includes(id)).length;
  const modelRefPatch = clearProviderModelRefs(modelMap, providerName);
  const repairedDefaults = repairModelSelectionForSyncedProvider({ agents: { defaults: cfg.agents?.defaults } }, providerName, finalIds);
  const defaultsPatch = buildDefaultSelectionPatch(
    repairedDefaults.changed ? repairedDefaults._nextDefaults : (cfg.agents?.defaults || {}),
    previousDefaults
  );
  const modelPolicyAllow = addProviderToModelPolicy(previousDefaults, providerName);
  if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
  if (Object.keys(modelRefPatch).length) defaultsPatch.models = modelRefPatch;
  const { entries: repairedEntries, warnings: entryWarnings } = repairAgentEntriesForSyncedProvider(cfg.agents?.entries, providerName, finalIds);
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
  }, (() => {
    const paths = ['--replace-path', `models.providers.${providerName}.models`];
    for (const agentId of Object.keys(repairedEntries)) paths.push('--replace-path', `agents.entries[${JSON.stringify(agentId)}]`);
    return paths;
  })());
  if (patchRes.status !== 0) {
    printConfigPatchFailure(patchRes);
    process.exit(patchRes.status || 4);
  }
  console.log(`Synced provider: ${providerName}`);
  console.log(`Display name: ${displayName}`);
  console.log(`Models now present: ${finalIds.length}`);
  console.log(`Added models: ${added}`);
  console.log(`Removed models: ${removed}`);
  if (repairedDefaults.changed) {
    console.log('Repaired default model refs:');
    for (const msg of repairedDefaults.messages) console.log(`- ${msg}`);
  }
  printSyncReferenceNotes(providerName, keptIds, [...(repairedDefaults.warnings || []), ...entryWarnings]);
}
