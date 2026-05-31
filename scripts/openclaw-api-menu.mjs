#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE = path.resolve(__dirname, '..');
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');
const RECENT_MODELS = path.join(__dirname, 'recent-models.json');
const STATUS_CACHE_TTL_MS = 60 * 1000; // 缓存从30秒改成1分钟,减少重复检测
const PINNED_DIRECT_SESSION_IDS = new Set(['153658104']);
const MODEL_STATUS_TIMEOUT_MS = 5000;
const MODEL_STATUS_RETRY_TIMEOUT_MS = 12000;
const MODEL_STATUS_TEST_PROMPT = 'ping';
const MODEL_STATUS_DEFAULT_PROMPT = '请用中文回答：如果你能正常看到这条请求，请回复“模型检测通过”，并补充一句不超过20字的自然中文。';
const MODEL_STATUS_USER_AGENT = 'Mozilla/5.0 BatchApiCheck/1.0';
const MODEL_STATUS_FALLBACK_ENDPOINTS = ['chat/completions', 'responses'];
const MODEL_STATUS_CACHE_SCHEMA = 'v3';
const LATEST_VERSION_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const GATEWAY_MENU_CACHE_TTL_MS = 2 * 60 * 1000;
const GATEWAY_RESTART_CHECK_INTERVAL_MS = 10 * 1000;
const GATEWAY_RESTART_CHECK_MAX_ATTEMPTS = 20;
const VERSION_HISTORY_VISIBLE_COUNT = 20;
const MENU_BACKUP_KEEP_MAX = 20;
const modelStatusCache = new Map();
// 维护规矩:
// 1. 每次修改本脚本前,必须先创建一个备份到 openclaw-api-menu-backups/ 文件夹,命名格式:openclaw-api-menu.mjs-Vx.y.z
// 2. 每次修改完成后,必须在 MENU_VERSION_HISTORY 顶部新增当前版本记录,当前版本号/更新时间会自动从该记录读取
// 3. 修改涉及界面输出时,先检查实际显示效果,避免重复分隔线、重复选项或错位
// 4. 非 TTY / Telegram 环境优先稳定显示,避免 console.clear() / 渐进刷新 / 重复刷屏
// 5. 新增交互功能时,优先保持与现有"操作完成 / 按任意键继续..."风格一致
// 6. MENU_VERSION_HISTORY 只保留最近 20 条;主菜单 [20] 版本记录页也只显示最近 20 条
// 7. 版本备份文件按实际版本号递增,例如:openclaw-api-menu.mjs-V4.9.100、openclaw-api-menu.mjs-V4.9.101
// 版本规则:
// - 小修改 / 小修复:V4.9.100、V4.9.101 这种递增
// - 大功能 / 大调整:V5.0、V5.1 这种大版本号递增
// 页面风格规则:新增菜单页 / 列表页 / 结果页默认沿用同一套样式
// =======================================
// 标题
// =======================================
// • 提示信息(可选)
// ---------------------------------------
// 内容区
// ---------------------------------------
// 请输入你的选择: / 操作完成
const HELPER_SCRIPT_TEMPLATES = {
  "add-provider.mjs": "#!/usr/bin/env node\nimport fs from 'fs';\nimport os from 'os';\nimport path from 'path';\nimport { fileURLToPath } from 'url';\n\nconst SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));\nconst CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');\nconst DISPLAY_NAMES = path.join(SCRIPT_DIR, 'provider-display-names.json');\n\nconst args = process.argv.slice(2);\nlet providerName, providerDisplayName, baseUrlRaw, apiKey;\nif (args.length >= 4) {\n  [providerName, providerDisplayName, baseUrlRaw, apiKey] = args;\n} else {\n  [providerName, baseUrlRaw, apiKey] = args;\n  providerDisplayName = providerName;\n}\nif (!providerName || !baseUrlRaw || !apiKey) {\n  console.error('Usage: node add-provider.mjs <providerName> [providerDisplayName] <baseUrl> <apiKey>');\n  process.exit(1);\n}\n\nconst baseUrl = baseUrlRaw.replace(/\\/+$/, '');\nconst modelsUrl = /\\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;\n\nif (!fs.existsSync(CONFIG)) {\n  console.error(`OpenClaw config not found: ${CONFIG}`);\n  console.error('Run OpenClaw at least once first so openclaw.json exists.');\n  process.exit(1);\n}\n\nfunction ensureJsonFile(file, fallback) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  if (!fs.existsSync(file)) {\n    fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\\n');\n    return structuredClone(fallback);\n  }\n  try {\n    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));\n    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {\n      return parsed;\n    }\n  } catch {}\n  fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\\n');\n  return structuredClone(fallback);\n}\n\nfunction writeJson(file, data) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n');\n}\n\nfunction guessInputCaps(id) {\n  const s = String(id).toLowerCase();\n  if (/(vision|vl|image|4o|gemini|gpt-4\\.1|o4)/.test(s)) return ['text', 'image'];\n  return ['text'];\n}\n\nfunction normalizeModel(displayName, id) {\n  return {\n    id,\n    name: `${displayName} / ${id}`,\n    input: guessInputCaps(id),\n    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\n    contextWindow: 1048576,\n    maxTokens: 128000,\n  };\n}\n\nconst cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));\nif (!cfg.models) cfg.models = {};\nif (!cfg.models.providers) cfg.models.providers = {};\nif (!cfg.agents) cfg.agents = {};\nif (!cfg.agents.defaults) cfg.agents.defaults = {};\nif (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};\n\nconst res = await fetch(modelsUrl, {\n  headers: {\n    Authorization: `Bearer ${apiKey}`,\n    Accept: 'application/json',\n  },\n});\n\nif (!res.ok) {\n  const text = await res.text().catch(() => '');\n  console.error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);\n  if (text) console.error(text.slice(0, 1000));\n  process.exit(2);\n}\n\nconst data = await res.json();\nconst rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];\nconst ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];\nif (!ids.length) {\n  console.error('No model IDs found in /models response');\n  process.exit(3);\n}\n\nconst displayNames = ensureJsonFile(DISPLAY_NAMES, {});\ndisplayNames[providerName] = providerDisplayName;\nwriteJson(DISPLAY_NAMES, displayNames);\n\nconst providerModels = ids.map(id => normalizeModel(providerDisplayName, id));\ncfg.models.providers[providerName] = {\n  baseUrl,\n  apiKey,\n  api: 'openai-completions',\n  models: providerModels,\n};\n\nfor (const id of ids) {\n  const ref = `${providerName}/${id}`;\n  if (!cfg.agents.defaults.models[ref]) cfg.agents.defaults.models[ref] = {};\n}\n\nconst backup = `${CONFIG}.bak.provider-${providerName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;\nfs.copyFileSync(CONFIG, backup);\nfs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\\n');\n\nconsole.log(`Added provider ${providerName}`);\nconsole.log(`Display name: ${providerDisplayName}`);\nconsole.log(`Config: ${CONFIG}`);\nconsole.log(`Base URL: ${baseUrl}`);\nconsole.log(`Models fetched: ${ids.length}`);\nconsole.log(`Backup: ${backup}`);\nconsole.log(`Display-name map: ${DISPLAY_NAMES}`);\nconsole.log('Sample models:');\nfor (const id of ids.slice(0, 20)) console.log(`- ${providerName}/${id}`);\n",
  "provider-manage.mjs": "#!/usr/bin/env node\nimport fs from 'fs';\nimport os from 'os';\nimport path from 'path';\nimport { fileURLToPath } from 'url';\n\nconst [action, providerInput, providerDisplayName] = process.argv.slice(2);\nif (!action || !providerInput || !['check','sync','remove','rename'].includes(action)) {\n  console.error('Usage: node provider-manage.mjs <check|sync|remove|rename> <providerNameOrDisplayName> [providerDisplayName]');\n  process.exit(1);\n}\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');\nconst DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');\nif (!fs.existsSync(CONFIG)) {\n  console.error(`OpenClaw config not found: ${CONFIG}`);\n  process.exit(1);\n}\n\nfunction ensureJsonFile(file, fallback) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  if (!fs.existsSync(file)) {\n    fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\\n');\n    return structuredClone(fallback);\n  }\n  try {\n    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));\n    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {\n      return parsed;\n    }\n  } catch {}\n  fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\\n');\n  return structuredClone(fallback);\n}\n\nfunction writeJson(file, data) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n');\n}\n\nconst cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));\nif (!cfg.models) cfg.models = {};\nif (!cfg.models.providers) cfg.models.providers = {};\nif (!cfg.agents) cfg.agents = {};\nif (!cfg.agents.defaults) cfg.agents.defaults = {};\nif (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};\n\nconst providers = cfg.models.providers || {};\nconst modelMap = cfg.agents.defaults.models || {};\nconst displayNames = ensureJsonFile(DISPLAY_NAMES, {});\n\nfunction resolveProviderKey(input) {\n  if (providers[input]) return input;\n  const lowered = String(input).toLowerCase();\n  for (const key of Object.keys(providers)) {\n    if (key.toLowerCase() === lowered) return key;\n  }\n  for (const [key, value] of Object.entries(displayNames)) {\n    if (String(value).toLowerCase() === lowered && providers[key]) return key;\n  }\n  return null;\n}\n\nconst providerName = resolveProviderKey(providerInput);\nconst provider = providerName ? providers[providerName] : null;\n\nfunction refsFor(name) {\n  return Object.keys(modelMap).filter(k => k.split('/')[0].toLowerCase() === name.toLowerCase());\n}\n\nfunction isProviderRef(ref, name) {\n  return typeof ref === 'string' && ref.split('/')[0]?.toLowerCase() === name.toLowerCase();\n}\n\nfunction pruneModelSelection(config, name) {\n  const defaults = config.agents?.defaults;\n  if (!defaults) return;\n\n  const pruneSelectionField = (fieldName) => {\n    const value = defaults[fieldName];\n    if (typeof value === 'string') {\n      if (isProviderRef(value, name)) delete defaults[fieldName];\n      return;\n    }\n    if (value && typeof value === 'object') {\n      if (isProviderRef(value.primary, name)) delete value.primary;\n      if (Array.isArray(value.fallbacks)) {\n        value.fallbacks = value.fallbacks.filter((ref) => !isProviderRef(ref, name));\n      }\n      if (!value.primary && (!Array.isArray(value.fallbacks) || value.fallbacks.length === 0)) {\n        delete defaults[fieldName];\n      }\n    }\n  };\n\n  pruneSelectionField('model');\n  pruneSelectionField('imageModel');\n  pruneSelectionField('pdfModel');\n  pruneSelectionField('audioModel');\n  pruneSelectionField('videoGenerationModel');\n  pruneSelectionField('musicGenerationModel');\n}\n\nfunction guessInputCaps(id) {\n  return /(vision|vl|image|4o|gemini|gpt-4\\.1|o4)/i.test(id) ? ['text', 'image'] : ['text'];\n}\n\nfunction getProviderDisplayName(name) {\n  return displayNames[name] || name;\n}\n\nif (action === 'check') {\n  if (!provider || !providerName) {\n    console.log(`Provider not found: ${providerInput}`);\n    process.exit(2);\n  }\n  const refs = refsFor(providerName);\n  console.log(`Provider: ${providerName}`);\n  console.log(`Display name: ${getProviderDisplayName(providerName)}`);\n  console.log(`Base URL: ${provider.baseUrl || '<none>'}`);\n  console.log(`API mode: ${provider.api || '<none>'}`);\n  console.log(`Configured provider.models: ${Array.isArray(provider.models) ? provider.models.length : 0}`);\n  console.log(`agents.defaults.models refs: ${refs.length}`);\n  for (const ref of refs.slice(0, 20)) console.log(`- ${ref}`);\n  process.exit(0);\n}\n\nif (action === 'rename') {\n  if (!provider || !providerName) {\n    console.error(`Provider not found: ${providerInput}`);\n    process.exit(2);\n  }\n  if (!providerDisplayName) {\n    console.error('Usage: node provider-manage.mjs rename <providerNameOrDisplayName> <providerDisplayName>');\n    process.exit(3);\n  }\n  const backup = `${CONFIG}.bak.manage-rename-${providerName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;\n  fs.copyFileSync(CONFIG, backup);\n  displayNames[providerName] = providerDisplayName;\n  writeJson(DISPLAY_NAMES, displayNames);\n  if (Array.isArray(provider.models)) {\n    provider.models = provider.models.map((model) => ({\n      ...model,\n      name: `${providerDisplayName} / ${model.id}`,\n    }));\n  }\n  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\\n');\n  console.log(`Renamed provider display: ${providerName} -> ${providerDisplayName}`);\n  console.log(`Backup: ${backup}`);\n  console.log(`Display-name map: ${DISPLAY_NAMES}`);\n  console.log('Now restart gateway: openclaw gateway restart');\n  process.exit(0);\n}\n\nif (action === 'remove') {\n  if (!provider || !providerName) {\n    console.error(`Provider not found: ${providerInput}`);\n    process.exit(2);\n  }\n  const modelConfig = cfg.agents?.defaults?.model;\n  const currentPrimary = typeof modelConfig === 'string' ? modelConfig : modelConfig?.primary;\n  if (typeof currentPrimary === 'string') {\n    const [pfx] = currentPrimary.split('/');\n    if (pfx.toLowerCase() === providerName.toLowerCase()) {\n      console.error(`Refusing to remove ${providerName}: default primary model is still using it (${currentPrimary})`);\n      process.exit(3);\n    }\n  }\n  const backup = `${CONFIG}.bak.manage-remove-${providerName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;\n  fs.copyFileSync(CONFIG, backup);\n  delete cfg.models.providers[providerName];\n  delete displayNames[providerName];\n  writeJson(DISPLAY_NAMES, displayNames);\n  let removed = 0;\n  for (const key of Object.keys(modelMap)) {\n    const [pfx] = key.split('/');\n    if (pfx.toLowerCase() === providerName.toLowerCase()) {\n      delete modelMap[key];\n      removed += 1;\n    }\n  }\n  pruneModelSelection(cfg, providerName);\n  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\\n');\n  console.log(`Removed provider: ${providerName}`);\n  console.log(`Removed refs: ${removed}`);\n  console.log(`Backup: ${backup}`);\n  console.log('Now restart gateway: openclaw gateway restart');\n  process.exit(0);\n}\n\nif (action === 'sync') {\n  if (!provider || !providerName) {\n    console.error(`Provider not found: ${providerInput}`);\n    process.exit(2);\n  }\n  if (!provider.baseUrl || !provider.apiKey) {\n    console.error(`Provider ${providerName} is missing baseUrl or apiKey in config`);\n    process.exit(3);\n  }\n  const baseUrl = String(provider.baseUrl).replace(/\\/+$/, '');\n  const modelsUrl = /\\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;\n  const res = await fetch(modelsUrl, {\n    headers: {\n      Authorization: `Bearer ${provider.apiKey}`,\n      Accept: 'application/json',\n    },\n  });\n  if (!res.ok) {\n    const text = await res.text().catch(() => '');\n    console.error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);\n    if (text) console.error(text.slice(0, 1000));\n    process.exit(4);\n  }\n  const data = await res.json();\n  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];\n  const ids = [...new Set(rows.map(x => x?.id).filter(Boolean))];\n  if (!ids.length) {\n    console.error('No model IDs found in /models response');\n    process.exit(5);\n  }\n  const backup = `${CONFIG}.bak.manage-sync-${providerName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;\n  fs.copyFileSync(CONFIG, backup);\n  const displayName = getProviderDisplayName(providerName);\n  provider.models = ids.map(id => ({\n    id,\n    name: `${displayName} / ${id}`,\n    input: guessInputCaps(id),\n    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\n    contextWindow: 1048576,\n    maxTokens: 128000,\n  }));\n  const wanted = new Set(ids.map(id => `${providerName}/${id}`));\n  let added = 0, removed = 0;\n  for (const key of Object.keys(modelMap)) {\n    const [pfx] = key.split('/');\n    if (pfx.toLowerCase() === providerName.toLowerCase() && !wanted.has(key)) {\n      delete modelMap[key];\n      removed += 1;\n    }\n  }\n  for (const ref of wanted) {\n    if (!modelMap[ref]) {\n      modelMap[ref] = {};\n      added += 1;\n    }\n  }\n  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\\n');\n  console.log(`Synced provider: ${providerName}`);\n  console.log(`Display name: ${displayName}`);\n  console.log(`Models now present: ${ids.length}`);\n  console.log(`Added refs: ${added}`);\n  console.log(`Removed stale refs: ${removed}`);\n  console.log(`Backup: ${backup}`);\n  console.log(`Display-name map: ${DISPLAY_NAMES}`);\n  console.log('Now restart gateway: openclaw gateway restart');\n}\n",
  "list-providers-cn.mjs": "#!/usr/bin/env node\nimport fs from 'fs';\nimport os from 'os';\nimport path from 'path';\nimport { fileURLToPath } from 'url';\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');\nconst DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');\n\nconst C = {\n  reset: '\\x1b[0m',\n  bold: '\\x1b[1m',\n  dim: '\\x1b[2m',\n  cyan: '\\x1b[36m',\n  green: '\\x1b[32m',\n  yellow: '\\x1b[33m',\n  red: '\\x1b[31m',\n  blue: '\\x1b[34m',\n  magenta: '\\x1b[35m',\n  gray: '\\x1b[90m',\n};\n\nconst color = (s, ...styles) => styles.join('') + s + C.reset;\n\nfunction readJson(file, fallback) {\n  try {\n    if (!fs.existsSync(file)) return fallback;\n    return JSON.parse(fs.readFileSync(file, 'utf8'));\n  } catch {\n    return fallback;\n  }\n}\n\nfunction maskUrl(url) {\n  if (!url || typeof url !== 'string') return '<none>';\n  try {\n    const u = new URL(url);\n    const short = `${u.protocol}//${u.host}${u.pathname.replace(/\\/$/, '') || '/'}`;\n    // 超过25个字符就截断\n    return short.length > 25 ? `${short.slice(0, 22)}...` : short;\n  } catch {\n    return url.length > 25 ? `${url.slice(0, 22)}...` : url;\n  }\n}\n\nasync function detectProviderStatus(provider) {\n  if (!provider?.baseUrl || !provider?.apiKey) {\n    return { online: false, latency: null, error: '未配置baseUrl或apiKey' };\n  }\n  const baseUrl = String(provider.baseUrl).replace(/\\/+$/, '');\n  const modelsUrl = /\\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;\n  const controller = new AbortController();\n  const timeoutId = setTimeout(() => controller.abort(), 5000);\n  const start = Date.now();\n  try {\n    // 改用GET请求,很多API不支持HEAD\n    const res = await fetch(modelsUrl, {\n      method: 'GET',\n      headers: { Authorization: `Bearer ${provider.apiKey}` },\n      signal: controller.signal,\n    });\n    clearTimeout(timeoutId);\n    const latency = Date.now() - start;\n    // 只要能收到响应就算在线,不管是200/401/403,说明接口可达\n    return { online: true, latency, error: res.ok ? null : `HTTP ${res.status}` };\n  } catch (err) {\n    clearTimeout(timeoutId);\n    // 只有网络错误/超时才算不可用\n    return { online: false, latency: null, error: err.name === 'AbortError' ? '超时' : err.message };\n  }\n}\n\nconst cfg = readJson(CONFIG, {});\nconst rawProviders = cfg.models?.providers || {};\nconst displayNames = readJson(DISPLAY_NAMES, {});\nconst primary = cfg.agents?.defaults?.model?.primary || '<none>';\nlet primaryDisplay = primary;\nif (primary !== '<none>' && primary.includes('/')) {\n  const [providerId, modelId] = primary.split('/');\n  const providerName = displayNames[providerId] || providerId;\n  primaryDisplay = `${providerName} / ${modelId}`;\n}\n\nconsole.log(color(`OpenClaw API 提供商列表 (共 ${Object.keys(rawProviders).length} 个)`, C.bold));\nconsole.log(color(`当前默认模型: ${primaryDisplay}`, C.dim));\nconsole.log(color('──────────────────────────────────────────────────────────────────────────────────────────────────────', C.gray));\n\nif (!Object.keys(rawProviders).length) {\n  console.log(color('  暂无配置的API提供商', C.yellow));\n  process.exit(0);\n}\n\nconst rows = Object.entries(rawProviders).map(([id, provider]) => {\n  const displayName = displayNames[id]\n    || (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string'\n      ? String(provider.models[0].name).split('/')[0].trim()\n      : id);\n  return {\n    id,\n    displayName,\n    provider,\n    baseUrl: maskUrl(provider?.baseUrl),\n    api: provider?.api || '<none>',\n    models: Array.isArray(provider?.models) ? provider.models.length : 0,\n    isPrimary: typeof primary === 'string' && primary.startsWith(`${id}/`),\n  };\n}).sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));\n\nconsole.log(color('正在检测所有API状态，请稍等...', C.blue));\nconst statusMap = new Map();\nfor (const row of rows) {\n  const status = await detectProviderStatus(row.provider);\n  statusMap.set(row.id, status);\n}\n\nrows.forEach((row, idx) => {\n  const status = statusMap.get(row.id) || {};\n  const no = String(idx + 1);\n  const primaryBadge = row.isPrimary ? color(' [默认]', C.yellow, C.bold) : '';\n  const statusDot = status.online ? color('●', C.green) : color('●', C.red);\n  let latencyColor = C.green;\n  if (status.latency >= 200 && status.latency < 500) latencyColor = C.yellow;\n  else if (status.latency >= 500) latencyColor = C.magenta;\n  const latencyText = status.online && status.latency ? `${color(`${status.latency}ms`, latencyColor)}` : color('不可用', C.red);\n  console.log(`${color(`[${no}]`, C.green, C.bold)} ${row.displayName} (${row.id})${primaryBadge} | API: ${color(row.baseUrl, C.white)} | 协议: ${color(row.api, C.white)} | 模型数量: ${color(String(row.models), C.yellow, C.bold)} | 延迟/状态: ${statusDot} ${latencyText}`);\n});\n"
};
const MENU_VERSION_HISTORY = [
  {
    version: 'V0.0.0',
    updatedAt: '2026-05-31',
    summary: [
      '手动将脚本版本号重置为 V0.0.0。',
    ],
  },
  {
    version: 'V4.9.103',
    updatedAt: '2026-05-10',
    summary: [
      '同步确认页新增 s/默认模型 选项:只改默认模型,不应用到任何 Telegram 会话。',
      'a/全局切换 恢复为只应用到所有 Telegram 会话,不再同时修改默认模型。',
    ],
  },
];
const MENU_BACKUP_PREFIX = 'openclaw-api-menu.mjs-V';
const MENU_BACKUP_DIR = path.join(__dirname, 'openclaw-api-menu-backups');
const providerStatusCache = new Map();
const menuRuntimeCache = {
  latestVersion: { value: null, ts: 0 },
  gatewayStatus: { value: null, ts: 0 },
};

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  blink: '\x1b[5m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

const color = (s, ...styles) => styles.join('') + s + C.reset;
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const visibleLen = (s) => {
  const text = stripAnsi(s);
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (
      code >= 0x1100 && (
        code <= 0x115f ||
        code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd)
      )
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
};
const line = (ch, n) => ch.repeat(Math.max(0, n));

function progressBar(current, total, width = 20) {
  const percent = Math.min(Math.max(current / total, 0), 1);
  const filled = Math.floor(percent * width);
  const empty = width - filled;
  return `[${color('='.repeat(filled), C.green, C.bold)}>${' '.repeat(empty)}] ${current}/${total}`;
}

function getProviderModelIds(config, providerId) {
  const rows = config?.models?.providers?.[providerId]?.models;
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.map((item) => item?.id).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
}

function formatModelListBlock(prefix, title, ids = [], limit = 12) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const visible = ids.slice(0, limit);
  const lines = [`${prefix} ${title}(${ids.length}):`];
  for (const id of visible) lines.push(` ${prefix === '➕' ? '+' : '-'} ${id}`);
  if (ids.length > limit) lines.push(` ${prefix === '➕' ? '+' : '-'} 其余 ${ids.length - limit} 个未展开`);
  return lines;
}

function formatModelDelta(beforeIds, afterIds) {
  const beforeSet = new Set(beforeIds || []);
  const afterSet = new Set(afterIds || []);
  const added = (afterIds || []).filter((id) => !beforeSet.has(id));
  const removed = (beforeIds || []).filter((id) => !afterSet.has(id));
  return { added, removed };
}

function runCommand(cmd, args = [], options = {}) {
  const baseOptions = { encoding: 'utf8', ...options };
  if (process.platform === 'win32') {
    const full = [cmd, ...args].map((part) => {
      const s = String(part);
      return /[\s"]/u.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
    }).join(' ');
    return spawnSync(full, { ...baseOptions, shell: true });
  }
  return spawnSync(cmd, args, baseOptions);
}


function ensureOcapiShortcut(options = {}) {
  const { verbose = false } = options;
  if (process.platform === 'win32') return { changed: false, skipped: true, reason: 'Windows 暂不自动写入 shell alias' };
  const bashrc = path.join(os.homedir(), '.bashrc');
  const aliasLine = `alias ocapi='node ${__filename}'`;
  try {
    const current = fs.existsSync(bashrc) ? fs.readFileSync(bashrc, 'utf8') : '';
    if (/^\s*alias\s+ocapi=/m.test(current) || current.includes(aliasLine)) {
      return { changed: false, exists: true, path: bashrc };
    }
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(bashrc, `${prefix}\n# OpenClaw API menu shortcut\n${aliasLine}\n`);
    if (verbose) {
      success('已添加快捷命令: ocapi');
      info('新开终端后可直接输入 ocapi；当前终端可执行: source ~/.bashrc');
    }
    return { changed: true, path: bashrc, aliasLine };
  } catch (err) {
    if (verbose) warn(`添加 ocapi 快捷命令失败:${err.message}`);
    return { changed: false, error: err.message, path: bashrc };
  }
}

function pruneDisplayNameMap(options = {}) {
  const { verbose = false } = options;
  const cfg = readJson(CONFIG, {});
  const providers = cfg.models?.providers || {};
  const displayNames = ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: false });
  const beforeKeys = Object.keys(displayNames);
  let removed = 0;
  for (const key of beforeKeys) {
    if (!providers[key]) {
      delete displayNames[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    writeJson(DISPLAY_NAMES, displayNames);
    if (verbose) info(`已清理 ${removed} 个失效的 provider 显示名映射。`);
  }
  return removed;
}

function ensureHelperScripts(options = {}) {
  const { verbose = false } = options;
  const created = [];
  for (const [name, content] of Object.entries(HELPER_SCRIPT_TEMPLATES)) {
    if (!content) continue;
    const target = path.join(__dirname, name);
    try {
      const desired = content.endsWith('\n') ? content : `${content}\n`;
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== desired) {
        fs.writeFileSync(target, desired, { mode: 0o755 });
        created.push(name);
      }
    } catch (err) {
      if (verbose) warn(`自动补全 ${name} 失败:${err.message}`);
    }
  }
  if (verbose && created.length) {
    success(`已自动补全/更新辅助脚本:${created.join('、')}`);
  }
  return created;
}

function getCurrentMenuDisplayVersion() {
  return getCurrentMenuVersionInfo().version;
}

function getCurrentMenuVersionInfo() {
  return MENU_VERSION_HISTORY[0] || {
    version: 'V0.0.0',
    updatedAt: '未知',
    summary: ['未填写当前版本摘要'],
  };
}

function ensureMenuBackupDir() {
  fs.mkdirSync(MENU_BACKUP_DIR, { recursive: true });
  return MENU_BACKUP_DIR;
}

function cleanupMenuBackups() {
  const backupDir = ensureMenuBackupDir();
  const entries = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(MENU_BACKUP_PREFIX))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {}
      return { name, fullPath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const stale = entries.slice(MENU_BACKUP_KEEP_MAX);
  for (const item of stale) {
    try {
      fs.unlinkSync(item.fullPath);
    } catch {}
  }
}

function createConfigBackup(tag = 'manual') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${CONFIG}.bak.${tag}-${timestamp}`;
  fs.copyFileSync(CONFIG, backupPath);
  return backupPath;
}

function parseMenuVersion(version) {
  const normalized = String(version || '').trim().toUpperCase();
  if (!/^V\d+(?:\.\d+)*$/.test(normalized)) {
    throw new Error(`菜单版本号格式无效:${version}`);
  }
  return normalized;
}

function compareMenuVersions(a, b) {
  const pa = parseMenuVersion(a).slice(1).split('.').map(Number);
  const pb = parseMenuVersion(b).slice(1).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getMenuBackupEntries() {
  const backupDir = ensureMenuBackupDir();
  const pattern = /^openclaw-api-menu\.mjs-(V\d+(?:\.\d+)*)$/i;
  return fs.readdirSync(backupDir)
    .map((name) => {
      const match = name.match(pattern);
      if (!match) return null;
      const fullPath = path.join(backupDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {}
      return { name, fullPath, version: match[1].toUpperCase(), mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => compareMenuVersions(b.version, a.version) || (b.mtimeMs - a.mtimeMs));
}

function getNextMenuBackupVersion(baseVersion = getCurrentMenuVersionInfo().version) {
  return parseMenuVersion(baseVersion);
}

function backupMenuScript(version = getCurrentMenuVersionInfo().version) {
  const scriptPath = path.join(__dirname, 'openclaw-api-menu.mjs');
  const currentStat = fs.statSync(scriptPath);
  const currentSize = currentStat.size;
  const currentContent = fs.readFileSync(scriptPath, 'utf8');
  const entries = getMenuBackupEntries();

  for (const entry of entries) {
    try {
      const backupStat = fs.statSync(entry.fullPath);
      if (backupStat.size !== currentSize) continue; // 大小不同，直接跳过
      if (fs.readFileSync(entry.fullPath, 'utf8') === currentContent) {
        cleanupMenuBackups();
        return { path: entry.fullPath, created: false, version: entry.version, deduped: true };
      }
    } catch {}
  }

  // 备份文件名必须跟随当前正式版本号，不能自动递增到未来版本。
  const backupVersion = getNextMenuBackupVersion(version);
  const backupName = `openclaw-api-menu.mjs-${backupVersion}`;
  const backupPath = path.join(ensureMenuBackupDir(), backupName);
  fs.copyFileSync(scriptPath, backupPath);
  cleanupMenuBackups();
  return { path: backupPath, created: true, version: backupVersion, deduped: false };
}

function remindMenuVersionBackup() {
  try {
    const result = backupMenuScript(getCurrentMenuVersionInfo().version);
    if (result.created) {
      info(`已自动备份主菜单脚本:${path.basename(result.path)}(版本 ${result.version})`);
    }
  } catch (err) {
    warn(`主菜单版本备份失败:${err.message}`);
  }
}

function splitModelRef(ref) {
  const text = String(ref || '');
  const firstSlash = text.indexOf('/');
  if (firstSlash === -1) return [text, ''];
  return [text.slice(0, firstSlash), text.slice(firstSlash + 1)];
}

function getMainSessionStorePath() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  return path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
}

function getSessionDisplayNameFromTrajectory(entry = {}) {
  const sessionId = entry.sessionId;
  if (!sessionId) return '';
  const file = path.join(getMainSessionStorePath(), '..', `${sessionId}.trajectory.jsonl`);
  try {
    if (!fs.existsSync(file)) return '';
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-80).reverse();
    for (const line of lines) {
      const obj = JSON.parse(line);
      const messages = obj?.data?.messagesSnapshot || obj?.data?.messages || [];
      for (const msg of messages) {
        if (msg?.customType !== 'openclaw.runtime-context' || typeof msg.content !== 'string') continue;
        const subject = msg.content.match(/"group_subject"\s*:\s*"([^"]+)"/)?.[1];
        if (subject) return subject;
        const label = msg.content.match(/"conversation_label"\s*:\s*"([^"]+)"/)?.[1];
        if (label) return label.replace(/\s+id:-?\d+\s*$/, '').trim();
      }
      const promptText = obj?.data?.systemPrompt || '';
      if (typeof promptText === 'string') {
        const subject = promptText.match(/"group_subject"\s*:\s*"([^"]+)"/)?.[1];
        if (subject) return subject;
        const label = promptText.match(/"conversation_label"\s*:\s*"([^"]+)"/)?.[1];
        if (label) return label.replace(/\s+id:-?\d+\s*$/, '').trim();
      }
    }
  } catch {}
  return '';
}

function cleanSessionDisplayName(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  text = text.replace(/^telegram:g-/, '').replace(/^telegram:d-/, '');
  text = text.replace(/\s+id:-?\d+\s*$/, '').trim();
  return text;
}

function getSessionFriendlyName(key, entry = {}) {
  const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const directFields = [
    entry.subject,
    entry.label,
    metadata.label,
    metadata.subject,
    entry.title,
    entry.name,
    entry.chatTitle,
    entry.conversationLabel,
    entry.peerName,
    entry.groupSubject,
    entry.displayName,
  ]
    .map(cleanSessionDisplayName)
    .filter(Boolean);
  if (directFields.length) return directFields[0];
  return getSessionDisplayNameFromTrajectory(entry);
}

function extractSessionTargetId(key) {
  const match = String(key || '').match(/^agent:[^:]+:[^:]+:(?:direct|group):(.+)$/);
  return match?.[1] || '';
}

function formatSessionKindLabel(key, entry = {}, duplicateNames = new Set()) {
  const text = String(key || '');
  const match = text.match(/^agent:([^:]+):([^:]+):(direct|group|slash):(.+)$/);
  if (match) {
    const [, , , kind, target] = match;
    const friendlyName = getSessionFriendlyName(key, entry);
    if (kind === 'direct') {
      const name = friendlyName || (target === '153658104' ? '奔奔' : target);
      return `TG私聊【${name}】`;
    }
    if (kind === 'group') {
      const name = friendlyName || target;
      return `TG群【${name}】`;
    }
    return `TG Slash【${friendlyName || target}】`;
  }
  if (entry.kind) return `${entry.kind}【${getSessionFriendlyName(key, entry) || text}】`;
  return getSessionFriendlyName(key, entry) || text;
}

function formatSessionModelLabel(entry = {}) {
  const providerId = entry.providerOverride || entry.modelProvider || '';
  const model = entry.modelOverride || entry.model || '';
  if (providerId && model) {
    const cfg = loadWorkspaceState().cfg;
    const provider = cfg.models?.providers?.[providerId];
    const displayName = getProviderLabel(providerId, provider);
    return `${formatProviderDisplay(displayName, providerId)} / ${model}`;
  }
  const cfg = loadWorkspaceState().cfg;
  const modelConfig = cfg.agents?.defaults?.model;
  const primary = typeof modelConfig === 'string' ? modelConfig : (modelConfig?.primary || '');
  if (!primary) return '未设置';
  const [defaultProviderId, defaultModelId] = splitModelRef(primary);
  if (!defaultProviderId || !defaultModelId) return primary;
  const provider = cfg.models?.providers?.[defaultProviderId];
  const displayName = getProviderLabel(defaultProviderId, provider);
  return `${formatProviderDisplay(displayName, defaultProviderId)} / ${defaultModelId}`;
}

function getActiveTelegramSessionFromStatus() {
  try {
    const res = runCommand('openclaw', ['sessions', '--json', '--active', '5'], { cwd: WORKSPACE, timeout: 8000 });
    const data = JSON.parse(`${res.stdout || ''}`.trim() || '{}');
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const currentGroups = sessions
      .filter((s) => /^agent:[^:]+:telegram:(group|direct):/.test(String(s?.key || '')))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return currentGroups[0] || null;
  } catch {
    return null;
  }
}

function listSyncableTelegramSessions(limit = 30) {
  const storePath = getMainSessionStorePath();
  const store = readJson(storePath, {});
  const rows = Object.entries(store || {})
    .filter(([key]) => /^agent:[^:]+:telegram:(group|direct):/.test(String(key)))
    .map(([key, entry]) => ({ key, entry: entry || {}, updatedAt: Number(entry?.updatedAt || 0) }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return { storePath, store, rows };
}

function applySessionModelOverrideInStore(store, sessionKey, ref) {
  const [providerId, modelId] = splitModelRef(ref);
  if (!providerId || !modelId) return { ok: false, reason: `模型引用无效:${ref}` };
  const entry = store?.[sessionKey];
  if (!entry || typeof entry !== 'object') return { ok: false, reason: '会话不存在。' };
  entry.providerOverride = providerId;
  entry.modelOverride = modelId;
  entry.modelOverrideSource = 'user';
  delete entry.model;
  delete entry.modelProvider;
  delete entry.contextTokens;
  delete entry.authProfileOverride;
  delete entry.authProfileOverrideSource;
  delete entry.authProfileOverrideCompactionCount;
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  entry.liveModelSwitchPending = true;
  entry.updatedAt = Date.now();
  return { ok: true };
}

function syncSessionModelOverrides(sessionKeys, ref) {
  const { storePath, store } = listSyncableTelegramSessions(1000);
  if (!fs.existsSync(storePath)) return { ok: false, synced: 0, reason: `会话文件不存在:${storePath}` };
  const keys = [...new Set(sessionKeys.filter(Boolean))];
  let synced = 0;
  const syncedKeys = [];
  const failed = [];
  for (const key of keys) {
    const result = applySessionModelOverrideInStore(store, key, ref);
    if (result.ok) {
      synced += 1;
      syncedKeys.push(key);
    } else {
      failed.push({ key, reason: result.reason });
    }
  }
  let backup = '';
  if (synced > 0) {
    backup = `${storePath}.bak.menu-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(storePath, backup);
    writeJson(storePath, store);
  }
  return { ok: failed.length === 0, synced, syncedKeys, failed, storePath, backup };
}

function deleteTelegramSessionRecords(sessionKeys) {
  const { storePath, store } = listSyncableTelegramSessions(1000);
  if (!fs.existsSync(storePath)) return { ok: false, deleted: 0, reason: `会话文件不存在:${storePath}` };
  const keys = [...new Set(sessionKeys.filter(Boolean))];
  const existingKeys = keys.filter((key) => store && Object.prototype.hasOwnProperty.call(store, key));
  if (!existingKeys.length) return { ok: true, deleted: 0, storePath };
  const backup = `${storePath}.bak.menu-delete-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(storePath, backup);
  for (const key of existingKeys) delete store[key];
  writeJson(storePath, store);
  return { ok: true, deleted: existingKeys.length, backup, storePath };
}

function getPinnedTelegramSessionRank(key, entry = {}) {
  const text = String(key || '');
  const match = text.match(/^agent:[^:]+:telegram:(direct|group):(.+)$/);
  if (!match) return 9;
  const [, kind, target] = match;
  if (kind === 'direct' && PINNED_DIRECT_SESSION_IDS.has(String(target))) return 0;
  if (kind === 'direct') return 1;
  if (kind === 'group') return 2;
  return 9;
}

function sortTelegramSessionsForMenu(rows = []) {
  return [...rows].sort((a, b) => {
    const rankDiff = getPinnedTelegramSessionRank(a?.key, a?.entry) - getPinnedTelegramSessionRank(b?.key, b?.entry);
    if (rankDiff !== 0) return rankDiff;
    const aName = getSessionTargetDisplayName(a?.key, a?.entry);
    const bName = getSessionTargetDisplayName(b?.key, b?.entry);
    const nameDiff = String(aName || '').localeCompare(String(bName || ''), 'zh-CN');
    if (nameDiff !== 0) return nameDiff;
    return String(a?.key || '').localeCompare(String(b?.key || ''), 'zh-CN');
  });
}

async function confirmSyncTelegramSessions(ask, ref) {
  while (true) {
    const { rows: rawRows } = listSyncableTelegramSessions(30);
    const rows = sortTelegramSessionsForMenu(rawRows);
    if (!rows.length) {
      info('未找到可同步的 Telegram 群/私聊会话,将只设置默认模型。');
      return { action: 'selected', skipped: true, sessionKeys: [], setDefaultOnly: true };
    }

    console.log(color('选择模型应用范围', C.yellow, C.bold));
    const activeSession = getActiveTelegramSessionFromStatus();
    const activeSessionKey = activeSession?.key || '';
    const nameCounts = new Map();
    for (const row of rows) {
      const name = getSessionFriendlyName(row.key, row.entry) || extractSessionTargetId(row.key) || row.key;
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    const duplicateNames = new Set([...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
    rows.forEach((row, idx) => {
      const label = formatSessionKindLabel(row.key, row.entry, duplicateNames);
      const modelLabel = row.key === activeSessionKey
        ? formatSessionModelLabel(activeSession || row.entry)
        : formatSessionModelLabel(row.entry);
      const activeTag = row.key === activeSessionKey ? color(' 当前使用中', C.yellow, C.bold) : '';
      const note = `${color(`当前模型：${modelLabel}`, C.gray)}${activeTag}`;
      console.log(renderNumberedLine(idx + 1, label, note, { rawNote: true }));
    });
    printActionFooter([
      { key: 'a', label: '全局切换' },
      { key: 's', label: '默认模型' },
      { key: 'd', label: '清理群聊记录' },
      { key: '0', label: '取消本次切换' },
    ], { blankLineBefore: false });

    const answer = (await ask(color('请输入你的选择: ', C.bold))).trim().toLowerCase();
    if (!answer || answer === '0') return { action: 'cancelled', sessionKeys: [], setDefaultOnly: false };

    if (answer === 'd') {
      const deleteAnswer = (await ask(color('输入要清理的群聊记录编号,支持空格分隔(0取消): ', C.yellow, C.bold))).trim().toLowerCase();
      if (!deleteAnswer || deleteAnswer === '0') continue;
      const idxs = [...new Set(deleteAnswer.split(/\s+/).map(x => Number(x)).filter(n => Number.isInteger(n) && n >= 1 && n <= rows.length))];
      if (!idxs.length) {
        warn('编号无效,请重新输入。');
        continue;
      }
      const selectedRows = idxs.map(idx => rows[idx - 1]);
      const names = selectedRows.map((row, i) => {
        const activeTag = row.key === activeSessionKey ? ' 当前使用中' : '';
        return `${i + 1}. ${formatSessionKindLabel(row.key, row.entry, duplicateNames)}${activeTag}`;
      });
      console.log(color('将清理以下列表记录:', C.yellow, C.bold));
      for (const name of names) console.log(name);
      const confirm = (await ask(color('确认清理这些列表记录？不会退出或删除 Telegram 群。(y/N): ', C.yellow, C.bold))).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        warn('已取消清理。');
        continue;
      }
      const result = deleteTelegramSessionRecords(selectedRows.map(row => row.key));
      if (result.deleted > 0) success(`已清理 ${result.deleted} 条列表记录。`);
      else warn(result.reason || '没有删除任何会话记录。');
      continue;
    }

    if (answer === 's') {
      return { action: 'selected', sessionKeys: [], setDefaultOnly: true, setDefaultToo: false };
    }

    let selectedRows;
    const setDefaultToo = false;
    if (answer === 'a' || answer === 'all') {
      selectedRows = rows;
    } else {
      const idxs = [...new Set(answer.split(/\s+/).map(x => Number(x)).filter(n => Number.isInteger(n) && n >= 1 && n <= rows.length))];
      if (!idxs.length) {
        warn('编号无效,请重新输入。');
        continue;
      }
      selectedRows = idxs.map(idx => rows[idx - 1]);
    }
    return { action: 'selected', sessionKeys: selectedRows.map(row => row.key), setDefaultOnly: false, setDefaultToo };
  }
}

function formatModelRefForHumans(ref) {
  const [providerId, modelId] = splitModelRef(ref);
  if (!providerId || !modelId) return String(ref || '该模型');
  const cfg = loadWorkspaceState().cfg;
  const provider = cfg.models?.providers?.[providerId];
  const displayName = getProviderLabel(providerId, provider);
  return `${formatProviderDisplay(displayName, providerId)} / ${modelId}`;
}

function getSessionTargetDisplayName(key, entry = {}) {
  const friendlyName = getSessionFriendlyName(key, entry);
  const text = String(key || '');
  const match = text.match(/^agent:[^:]+:telegram:(direct|group):(.+)$/);
  if (!match) return friendlyName || text || '会话';
  const [, kind, target] = match;
  if (kind === 'direct') return friendlyName || (target === '153658104' ? '奔奔' : target);
  if (kind === 'group') return friendlyName || target || '未命名群聊';
  return friendlyName || target || '会话';
}

function describeSessionTargets(sessionKeys = []) {
  const { store } = listSyncableTelegramSessions(1000);
  const rows = [...new Set((sessionKeys || []).filter(Boolean))]
    .map((key) => ({ key, entry: store?.[key] || {} }));
  const groupNames = rows
    .filter((row) => /^agent:[^:]+:telegram:group:/.test(String(row.key || '')))
    .map((row) => getSessionTargetDisplayName(row.key, row.entry))
    .filter(Boolean);
  const directNames = rows
    .filter((row) => /^agent:[^:]+:telegram:direct:/.test(String(row.key || '')))
    .map((row) => getSessionTargetDisplayName(row.key, row.entry))
    .filter(Boolean);
  return { groupNames, directNames };
}

function buildSessionSyncSuccessMessage(ref, sessionKeys = []) {
  const modelLabel = formatModelRefForHumans(ref);
  const { groupNames, directNames } = describeSessionTargets(sessionKeys);
  const total = groupNames.length + directNames.length;
  if (total <= 0) return `${modelLabel} 已应用。`;
  if (groupNames.length === 1 && directNames.length === 0) return `${modelLabel} 已应用到群“${groupNames[0]}”。`;
  if (groupNames.length > 1 && directNames.length === 0) return `${modelLabel} 已应用到 ${groupNames.length} 个群。`;
  if (groupNames.length === 0 && directNames.length === 1) return `${modelLabel} 已应用到私聊“${directNames[0]}”。`;
  if (groupNames.length === 0 && directNames.length > 1) return `${modelLabel} 已应用到 ${directNames.length} 个私聊。`;
  return `${modelLabel} 已应用到 ${total} 个会话（${groupNames.length} 个群，${directNames.length} 个私聊）。`;
}

function applySelectedSessionSync(selection, ref) {
  if (!selection || selection.action === 'cancelled') return { cancelled: true, synced: 0 };
  if (!selection.sessionKeys?.length) return { skipped: true, synced: 0 };
  const result = syncSessionModelOverrides(selection.sessionKeys, ref);
  if (result.synced > 0) {
    const appliedKeys = result.syncedKeys?.length ? result.syncedKeys : (selection.sessionKeys || []).slice(0, result.synced);
    success(buildSessionSyncSuccessMessage(ref, appliedKeys));
  }
  if (result.failed?.length) warn(`有 ${result.failed.length} 个群聊/会话应用失败，可稍后重试。`);
  return result;
}

function getProviderLabel(providerId, provider) {
  // 从 provider-display-names.json 读取显示名，回退到 providerId
  try {
    const dn = readJson(DISPLAY_NAMES, {});
    return dn[providerId] || providerId;
  } catch {
    return providerId;
  }
}

function formatProviderDisplay(displayName, id) {
  return `${displayName}(${id})`;
}

function formatProviderRow(row) {
  return formatProviderDisplay(row.displayName, row.id);
}

function getCurrentDefaultModel() {
  const cfg = loadWorkspaceState().cfg;
  const modelConfig = cfg.agents?.defaults?.model;
  const primary = typeof modelConfig === 'string' ? modelConfig : (modelConfig?.primary || '');
  if (!primary) return color('未设置', C.gray);
  const [providerId, modelId] = splitModelRef(primary);
  const provider = cfg.models?.providers?.[providerId];
  if (!provider || !Array.isArray(provider.models)) return primary;
  const model = provider.models.find(m => m.id === modelId);
  return model?.name || primary;
}

function getOpenClawVersion() {
  try {
    const res = runCommand('openclaw', ['--version']);
    return (res.stdout || '').trim() || (res.stderr || '').trim() || '未知版本';
  } catch {
    return '未知版本';
  }
}

function extractOpenClawVersion(versionText, fallback = '') {
  const text = String(versionText || '').trim();
  return text.match(/\d{4}\.\d+\.\d+(?:-\d+)?/)?.[0] || fallback || text;
}

function box(title, lines = [], tone = C.cyan) {
  const content = [title, ...lines].map(x => stripAnsi(x));
  const width = Math.max(...content.map(visibleLen), 55);
  const top = color(`╭${line('─', width + 2)}╮`, tone, C.bold);
  const bottom = color(`╰${line('─', width + 2)}╯`, tone, C.bold);
  const body = [title, ...lines].map((raw, idx) => {
    const text = idx === 0 ? color(raw, C.bold) : raw;
    const pad = width - visibleLen(raw);
    return color('│ ', tone, C.bold) + text + ' '.repeat(pad) + color(' │', tone, C.bold);
  });
  return [top, ...body, bottom].join('\n');
}

function section(title) {
  console.log('');
  console.log(color(`▶ ${title}`, C.magenta, C.bold));
  console.log(color('─'.repeat(Math.max(18, stripAnsi(title).length + 2)), C.gray));
  console.log('');
}

function info(msg) {
  console.log(color(`• ${msg}`, C.white, C.bold));
}

function success(msg) {
  console.log(color(`✔ ${msg}`, C.green, C.bold));
}

function warn(msg) {
  console.log(color(`⚠ ${msg}`, C.yellow, C.bold));
}

function danger(msg) {
  console.log(color(`✖ ${msg}`, C.red, C.bold));
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function cloneFallback(fallback) {
  if (fallback === undefined || fallback === null) return fallback;
  if (typeof structuredClone === 'function') return structuredClone(fallback);
  return JSON.parse(JSON.stringify(fallback));
}

function ensureJsonFile(file, fallback, options = {}) {
  const { label = path.basename(file), verbose = false } = options;
  const initial = cloneFallback(fallback);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n');
      if (verbose) info(`首次使用:已自动创建 ${label}`);
      return initial;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(fallback)) {
        if (Array.isArray(parsed)) return parsed;
      } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
    fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n');
    if (verbose) warn(`${label} 内容无效,已自动重置为默认结构。`);
    return initial;
  } catch (err) {
    if (verbose) danger(`处理 ${label} 失败:${err.message}`);
    return initial;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function ensureConfigSkeleton() {
  let created = false;
  let cfg = readJson(CONFIG, null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    cfg = {};
    created = !fs.existsSync(CONFIG);
  }
  if (!cfg.models || typeof cfg.models !== 'object' || Array.isArray(cfg.models)) cfg.models = {};
  if (!cfg.models.providers || typeof cfg.models.providers !== 'object' || Array.isArray(cfg.models.providers)) cfg.models.providers = {};
  if (!cfg.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) cfg.agents = {};
  if (!cfg.agents.defaults || typeof cfg.agents.defaults !== 'object' || Array.isArray(cfg.agents.defaults)) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.models || typeof cfg.agents.defaults.models !== 'object' || Array.isArray(cfg.agents.defaults.models)) cfg.agents.defaults.models = {};
  return { cfg, created };
}

function loadWorkspaceState(options = {}) {
  const { verbose = false } = options;
  const ensured = ensureConfigSkeleton();
  if (ensured.created) {
    return {
      ok: false,
      cfg: ensured.cfg,
      displayNames: ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose }),
      recentModels: ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json', verbose }),
      reason: `还没检测到 OpenClaw 主配置:${CONFIG}`,
      hint: '请先至少运行一次 OpenClaw,让 openclaw.json 自动生成后再继续。',
    };
  }
  ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose });
  ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json', verbose });
  return {
    ok: true,
    cfg: ensured.cfg,
    displayNames: readJson(DISPLAY_NAMES, {}),
    recentModels: readJson(RECENT_MODELS, []),
    reason: null,
    hint: null,
  };
}

function backupConfig(tag = 'manual') {
  return createConfigBackup(tag);
}

function getWorkspaceSkillsDir() {
  return path.join('/root/.openclaw/workspace', 'skills');
}

function normalizeSkillDescription(skillName, rawDescription = '') {
  const text = String(rawDescription || '').trim();
  const builtins = {
    'acp-router': 'ACP 会话路由',
    'browser-automation': '网页自动操作',
    'ebook-localizer': '电子书中文翻译',
    'healthcheck': '主机安全体检',
    'node-connect': '节点连接排障',
    'skill-creator': '技能创建与整理',
    'taskflow': '多步骤任务流',
    'taskflow-inbox-triage': '任务流收件分拣',
    'tmux': 'Tmux 远程控制',
    'video-frames': '视频抽帧处理',
    'weather': '天气查询',
  };
  if (builtins[skillName]) return builtins[skillName];
  if (!text) return '未读取到说明';
  const compact = text
    .replace(/^use when\s*/i, '')
    .replace(/^route\s*/i, '')
    .replace(/^create, edit, improve, tidy, review, audit, or restructure\s*/i, '管理')
    .replace(/skills?/gi, '技能')
    .replace(/AgentSkills?/gi, '技能')
    .replace(/OpenClaw/gi, 'OpenClaw')
    .replace(/especially .*$/i, '')
    .replace(/, especially .*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const shortened = compact.length > 18 ? `${compact.slice(0, 18)}...` : compact;
  return shortened || '未读取到说明';
}

function listInstalledSkills() {
  const skillsDir = getWorkspaceSkillsDir();
  try {
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(skillsDir, entry.name);
        const skillFile = path.join(fullPath, 'SKILL.md');
        let description = '未读取到用途说明';
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, 'utf8');
            const match = content.match(/^description:\s*(.+)$/m);
            if (match?.[1]) {
              description = match[1].trim().replace(/^['"]|['"]$/g, '');
            }
          } catch {}
        }
        return {
          name: entry.name,
          path: fullPath,
          hasSkillFile: fs.existsSync(skillFile),
          description: normalizeSkillDescription(entry.name, description),
        };
      })
      .filter((item) => item.hasSkillFile)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch {
    return [];
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function readRecentModels() {
  return ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json' }).slice(0, 15);
}

function writeRecentModels(list) {
  // 字段净化:只保留必要字段,防止provider敏感信息(apiKey/baseUrl等)落盘
  const cleanList = list.slice(0, 15).map(item => ({
    ref: item.ref,
    name: item.name,
    provider: item.provider,
  }));
  writeJson(RECENT_MODELS, cleanList);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const size = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(Array.from({ length: size }, () => runOne()));
  return results;
}

function addRecentModel(ref, name, provider) {
  const recent = readRecentModels();
  const [providerId, modelId] = splitModelRef(ref);
  const displayName = provider || providerId;
  const normalizedName = name && String(name).includes(') / ')
    ? name
    : `${displayName}(${providerId}) / ${modelId}`;
  const filtered = recent.filter(item => item.ref !== ref);
  filtered.unshift({ ref, name: normalizedName, provider: displayName });
  writeRecentModels(filtered);
}

function maskUrl(url) {
  if (!url || typeof url !== 'string') return '<none>';
  try {
    const u = new URL(url);
    const short = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '') || '/'}`;
    return short.length > 28 ? `${short.slice(0, 25)}...` : short;
  } catch {
    return url.length > 28 ? `${url.slice(0, 25)}...` : url;
  }
}

async function detectProviderStatus(provider) {
  try {
    if (!provider?.baseUrl || !provider?.apiKey) return { online: false, latency: null, error: '未配置baseUrl或apiKey', _cached: false };
    const baseUrl = String(provider.baseUrl).replace(/\/+$/, '');
    const cacheKey = `${baseUrl}::${provider.apiKey}`;
    const cached = providerStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL_MS) {
      return { ...cached.value, _cached: true };
    }
    const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const start = Date.now();
    try {
      const res = await fetch(modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latency = Date.now() - start;
      const result = { online: res.ok, latency, error: res.ok ? null : `HTTP ${res.status}` };
      providerStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return { ...result, _cached: false };
    } catch (err) {
      clearTimeout(timeoutId);
      const result = { online: false, latency: null, error: err.name === 'AbortError' ? '超时' : err.message };
      providerStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return { ...result, _cached: false };
    }
  } catch {
    return { online: false, latency: null, error: 'network error', _cached: false };
  }
}

function getCurrentModelRef() {
  const cfg = loadWorkspaceState().cfg;
  const modelConfig = cfg.agents?.defaults?.model;
  return typeof modelConfig === 'string' ? modelConfig : (modelConfig?.primary || '');
}

function summarizeErrorMessage(message, maxLen = 120) {
  let text = String(message || '')
    .replace(/\s*\r?\n\s*/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '未知原因';
  const directTranslations = [
    [/no available keys in pool/ig, '密钥池无可用 key'],
    [/invalid token/ig, '密钥无效'],
    [/invalid api key/ig, 'API Key 无效'],
    [/unauthorized/ig, '未授权'],
    [/forbidden/ig, '无权限访问'],
    [/model not found/ig, '模型不存在'],
    [/unknown model/ig, '未知模型'],
    [/invalid model/ig, '模型无效'],
    [/bad response status code\s*503/ig, '上游服务暂时不可用(503)'],
    [/bad response status code\s*502/ig, '上游服务异常(502)'],
    [/bad response status code\s*504/ig, '上游服务超时(504)'],
    [/request timeout/ig, '请求超时'],
    [/timeout/ig, '超时'],
  ];
  for (const [pattern, replacement] of directTranslations) {
    text = text.replace(pattern, replacement);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

function seedRecentModelsFromCurrentDefault() {
  const cfg = loadWorkspaceState().cfg;
  const currentRef = getCurrentModelRef();
  if (!currentRef) return false;
  const [providerId, modelId] = splitModelRef(currentRef);
  const provider = cfg.models?.providers?.[providerId];
  if (!provider || !Array.isArray(provider.models)) return false;
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return false;
  const displayName = getProviderLabel(providerId, provider);
  addRecentModel(currentRef, model.name || `${displayName}(${providerId}) / ${modelId}`, displayName);
  return true;
}

function buildOpenAICompatibleEndpoint(baseUrl, endpoint) {
  const cleanBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  const cleanEndpoint = String(endpoint || '').replace(/^\/+/, '');
  if (!cleanBaseUrl || !cleanEndpoint) return '';
  return /\/v1$/i.test(cleanBaseUrl) ? `${cleanBaseUrl}/${cleanEndpoint}` : `${cleanBaseUrl}/v1/${cleanEndpoint}`;
}

function buildModelProbePayload(endpoint, modelId, promptText = MODEL_STATUS_DEFAULT_PROMPT) {
  const safePrompt = String(promptText || MODEL_STATUS_DEFAULT_PROMPT).trim() || MODEL_STATUS_DEFAULT_PROMPT;
  if (endpoint === 'responses') {
    return {
      model: modelId,
      input: safePrompt,
      max_output_tokens: 16,
    };
  }
  return {
    model: modelId,
    messages: [{ role: 'user', content: safePrompt }],
    stream: true,
    stream_options: { include_usage: true },
  };
}

function extractJsonFromProbeText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { data: null, parseError: '空响应' };
  try {
    return { data: JSON.parse(text), parseError: null };
  } catch (e) {
    return { data: null, parseError: e?.message || '响应解析失败' };
  }
}

function assembleChatCompletionSSE(rawText) {
  const text = String(rawText || '');
  const lines = text.split(/\r?\n/);
  let returnedModel = '';
  let content = '';
  let reasoningContent = '';
  let usage = null;
  let chunkCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') break;
    try {
      const chunk = JSON.parse(jsonStr);
      chunkCount += 1;
      if (!returnedModel && chunk?.model) returnedModel = String(chunk.model);
      if (chunk?.usage) usage = chunk.usage;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) content += String(delta.content);
      if (delta.reasoning_content) reasoningContent += String(delta.reasoning_content);
      if (delta.thinking) reasoningContent += String(delta.thinking);
    } catch {}
  }
  if (chunkCount <= 0) return null;
  return {
    model: returnedModel || undefined,
    choices: [{ message: { role: 'assistant', content: content || null, reasoning_content: reasoningContent || undefined } }],
    usage,
    isStreamAssembled: true,
    _chunkCount: chunkCount,
  };
}

function normalizeProbeSuccessShape(endpoint, data) {
  if (!data || typeof data !== 'object') return false;
  if (endpoint === 'responses') {
    if (Array.isArray(data.output) && data.output.length > 0) return true;
    if (String(data.status || '').toLowerCase() === 'completed') return true;
    return false;
  }
  if (!Array.isArray(data.choices) || data.choices.length <= 0) return false;
  const firstChoice = data.choices[0] || {};
  const message = firstChoice.message || {};
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
  return !!(content || reasoning || firstChoice.finish_reason || data.isStreamAssembled);
}

function classifyProbeFailure({ endpoint, res, data, parseError }) {
  const rawMessage = data?.error?.message || data?.message || parseError || `HTTP ${res?.status || 0}`;
  const errMsg = String(rawMessage || '').toLowerCase();
  if (res?.status === 401 || res?.status === 403 || errMsg.includes('unauthorized') || errMsg.includes('invalid api key')) {
    return { status: 'auth_failed', error: summarizeErrorMessage(rawMessage) };
  }
  if (errMsg.includes('model not found') || errMsg.includes('unknown model') || errMsg.includes('invalid model')) {
    return { status: 'model_not_found', error: summarizeErrorMessage(rawMessage || '模型不存在') };
  }
  if (
    errMsg.includes('not supported') ||
    errMsg.includes('unsupported') ||
    errMsg.includes('does not support') ||
    errMsg.includes('chat.completions not supported') ||
    errMsg.includes('responses endpoint not found') ||
    errMsg.includes('responses api') ||
    errMsg.includes('invalid_request_error')
  ) {
    return { status: 'incompatible', error: summarizeErrorMessage(rawMessage || `接口不兼容:不支持${endpoint}`) };
  }
  if (!res?.ok) {
    return { status: 'failed', error: summarizeErrorMessage(rawMessage) };
  }
  if (parseError) {
    return { status: 'failed', error: summarizeErrorMessage(parseError) };
  }
  if (data?.error) {
    return { status: 'failed', error: summarizeErrorMessage(data.error.message || data.error || '接口返回错误') };
  }
  if (!normalizeProbeSuccessShape(endpoint, data)) {
    return { status: 'incompatible', error: summarizeErrorMessage(`响应结构异常:${endpoint === 'responses' ? '无output/status' : '无choices数组'}`) };
  }
  return { status: 'available', error: null };
}

async function readChatCompletionProbeStream(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return { rawText: await res.text(), earlyData: null };
  const decoder = new TextDecoder();
  let rawText = '';
  let returnedModel = '';
  let content = '';
  let reasoningContent = '';
  let usage = null;
  let chunkCount = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      rawText += decoder.decode(value, { stream: true });
      const lines = rawText.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(jsonStr);
          chunkCount += 1;
          if (!returnedModel && chunk?.model) returnedModel = String(chunk.model);
          if (chunk?.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta;
          if (delta?.content) content += String(delta.content);
          if (delta?.reasoning_content) reasoningContent += String(delta.reasoning_content);
          if (delta?.thinking) reasoningContent += String(delta.thinking);
          const hasValidChoice = Array.isArray(chunk?.choices) && chunk.choices.length > 0;
          const hasRealContent = delta?.content || delta?.reasoning_content || delta?.thinking;
          const finishReason = chunk?.choices?.[0]?.finish_reason;
          // 纯 role chunk(如 {role:"assistant"})不等同于模型可用,等后续真的有内容/reasoning了再判定
          if (hasValidChoice && (hasRealContent || finishReason)) {
            try { await reader.cancel(); } catch {}
            return {
              rawText,
              earlyData: {
                model: returnedModel || undefined,
                choices: [{ message: { role: 'assistant', content: content || null, reasoning_content: reasoningContent || undefined }, finish_reason: finishReason || undefined }],
                usage,
                isStreamAssembled: true,
                isEarlyStreamProbe: true,
                _chunkCount: chunkCount,
              },
            };
          }
        } catch {}
      }
    }
  } finally {
    rawText += decoder.decode();
  }
  return { rawText, earlyData: null };
}

async function probeModelEndpoint(provider, modelId, endpoint, signal, options = {}) {
  const promptText = String(options.promptText || MODEL_STATUS_DEFAULT_PROMPT).trim() || MODEL_STATUS_DEFAULT_PROMPT;
  const baseUrl = String(provider.baseUrl).replace(/\/+$/, '');
  const url = buildOpenAICompatibleEndpoint(baseUrl, endpoint);
  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: endpoint === 'responses' ? 'application/json' : 'text/event-stream, application/json',
      'User-Agent': MODEL_STATUS_USER_AGENT,
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(buildModelProbePayload(endpoint, modelId, promptText)),
    signal,
  });
  const latency = Date.now() - start;
  const streamResult = endpoint === 'chat/completions'
    ? await readChatCompletionProbeStream(res)
    : { rawText: await res.text(), earlyData: null };
  const rawText = streamResult.rawText;
  let parsed = endpoint === 'chat/completions'
    ? { data: streamResult.earlyData || assembleChatCompletionSSE(rawText), parseError: null }
    : extractJsonFromProbeText(rawText);
  if (!parsed.data) parsed = extractJsonFromProbeText(rawText);
  const { data, parseError } = parsed;
  const classified = classifyProbeFailure({ endpoint, res, data, parseError });
  return {
    endpoint,
    latency,
    rawText,
    data,
    parseError,
    resOk: res.ok,
    httpStatus: res.status,
    ...classified,
  };
}

async function detectModelStatus(provider, modelId, options = {}) {
  // 提前定义cacheKey到函数作用域,避免最外层catch访问不到
  let cacheKey = null;
  try {
    if (!provider?.baseUrl || !provider?.apiKey || !modelId) {
      return {
        status: 'failed',
        latency: null,
        error: '未配置baseUrl或apiKey,或缺少模型ID',
        _cached: false,
        modelExistsLocally: true
      };
    }
    const promptText = String(options?.promptText || MODEL_STATUS_DEFAULT_PROMPT).trim() || MODEL_STATUS_DEFAULT_PROMPT;
    const timeoutMs = Number(options?.timeoutMs || MODEL_STATUS_TIMEOUT_MS);
    const baseUrl = String(provider.baseUrl).replace(/\/+$/, '');
    cacheKey = `${MODEL_STATUS_CACHE_SCHEMA}::timeout:${timeoutMs}::${baseUrl}::${provider.apiKey}::${modelId}::${promptText.slice(0, 160)}`;
    const cached = options?.skipCache === true ? null : modelStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL_MS) {
      return { ...cached.value, _cached: true };
    }
    const modelExistsLocally = Array.isArray(provider.models) && provider.models.some(m => m.id === modelId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let bestFailure = null;
      for (const endpoint of MODEL_STATUS_FALLBACK_ENDPOINTS) {
        const probe = await probeModelEndpoint(provider, modelId, endpoint, controller.signal, { promptText });
        if (probe.status === 'available') {
          const result = {
            status: 'available',
            latency: probe.latency,
            error: null,
            endpoint: probe.endpoint,
            httpStatus: probe.httpStatus,
            _cached: false,
            modelExistsLocally,
            online: true,
          };
          modelStatusCache.set(cacheKey, { ts: Date.now(), value: result });
          clearTimeout(timeoutId);
          return result;
        }
        if (!bestFailure || (bestFailure.status !== 'auth_failed' && probe.status === 'auth_failed')) {
          bestFailure = probe;
        }
        if (probe.status === 'auth_failed' || probe.status === 'model_not_found') break;
      }
      clearTimeout(timeoutId);
      const result = {
        status: bestFailure?.status || 'failed',
        latency: bestFailure?.latency || null,
        error: bestFailure?.error || '模型检测失败',
        endpoint: bestFailure?.endpoint || MODEL_STATUS_FALLBACK_ENDPOINTS[0],
        httpStatus: bestFailure?.httpStatus || null,
        _cached: false,
        modelExistsLocally,
        online: true,
      };
      modelStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timeout');
      const status = isTimeout ? 'timeout' : 'failed';
      const error = isTimeout ? '请求超时' : summarizeErrorMessage(err?.message || '网络连接失败');
      const result = { status, latency: isTimeout ? timeoutMs : null, error, _cached: false, modelExistsLocally, online: false };
      modelStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return result;
    }
  } catch {
    const result = { status: 'failed', latency: null, error: '模型检测失败', _cached: false, modelExistsLocally: true, online: false };
    if (cacheKey) modelStatusCache.set(cacheKey, { ts: Date.now(), value: result });
    return result;
  }
}

async function confirmSwitchWhenModelCheckFailed(ask, modelStatus, retryDetect = null) {
  let currentStatus = modelStatus;
  while (currentStatus?.status !== 'available') {
    warn(`该模型检测未通过:${formatModelCheckResult(currentStatus)}`);
    console.log(`${color('1.  ', C.white, C.bold)}再测一次`);
    console.log(`${color('2.  ', C.white, C.bold)}仍然切换`);
    console.log(`${color('0.  ', C.white, C.bold)}取消`);
    const answer = await ask(color('请输入你的选择: ', C.bold));
    if (answer === '2' || answer.toLowerCase() === 'y') return true;
    if (answer === '1' && typeof retryDetect === 'function') {
      info(`正在重新检测，请稍等...`);
      currentStatus = await retryDetect();
      if (currentStatus?.status === 'available') {
        success(`重新检测通过:${formatModelCheckResult(currentStatus)}`);
        return true;
      }
      continue;
    }
    return false;
  }
  return true;
}

function explainModelError(error = '') {
  return '';
}

function getStatusVisual(status) {
  let latencyColor = C.green;
  if (status?.latency >= 200 && status.latency < 500) latencyColor = C.yellow;
  else if (status?.latency >= 500) latencyColor = C.magenta;
  return {
    statusDot: status?.online ? color('●', latencyColor) : color('●', C.red, C.blink),
    latencyText: status?.online && status?.latency ? color(`${status.latency}ms`, latencyColor) : color('不可用', C.red, C.bold),
  };
}


function formatModelCheckResult(status) {
  if (!status) return '不可用 | 未知错误';
  const { status: testStatus, error, modelExistsLocally } = status;
  const suffix = !modelExistsLocally ? ' | 模型未在本地列表中' : '';
  const explain = explainModelError(error);
  const explainText = explain ? `(${explain})` : '';
  switch (testStatus) {
    case 'checking':
      return `检测中${suffix}`;
    case 'available':
      return `可用${suffix}`;
    default:
      return `不可用 | ${error || '未知原因'}${explainText}${suffix}`;
  }
}

function formatModelCheckResultColored(status, options = {}) {
  const brief = options.brief === true;
  if (!status) return color('不可用', C.red, C.bold) + (brief ? '' : ` | ${color('未知错误', C.gray)}`);
  const { status: testStatus, error, modelExistsLocally } = status;
  const suffix = !modelExistsLocally ? color(' | 模型未在本地列表中', C.yellow) : '';
  const explain = explainModelError(error);
  const explainText = explain ? `(${explain})` : '';
  switch (testStatus) {
    case 'checking':
      return `${color('检测中', C.yellow, C.bold)}${suffix}`;
    case 'available':
      return `${color('可用', C.green, C.bold)}${suffix}`;
    default:
      return brief
        ? `${color('不可用', C.red, C.bold)}${suffix}`
        : `${color('不可用', C.red, C.bold)} | ${color(`${error || '未知原因'}${explainText}`, C.gray)}${suffix}`;
  }
}

function formatProviderStatusCompact(status) {
  const { statusDot, latencyText } = getStatusVisual(status || {});
  return `${statusDot} ${latencyText}`;
}

function formatProviderStatusForProviderList(status) {
  if (status?.checking) return color('检测中', C.yellow, C.bold);
  const latencyColor = status?.latency < 200 ? C.green : status?.latency < 500 ? C.yellow : C.magenta;
  const stateText = status?.online ? color('在线', C.green, C.bold) : color('离线', C.red, C.bold);
  const latencyText = status?.online && status?.latency
    ? color(`${status.latency}ms`, latencyColor, C.bold)
    : '';
  return latencyText ? `${stateText} | ${latencyText}` : `${stateText}`;
}

async function getProviderQuota(providerId, provider) {

  if (!provider?.baseUrl || !provider?.apiKey) return { used: 0, total: null, remaining: null, percent: 0 };
  try {
    const baseUrl = String(provider.baseUrl).replace(/\/+$/, '');
    // 公益站通用适配,尝试多个常见路径
    const quotaPaths = [
      '/v1/dashboard/billing/credit_grants',
      '/dashboard/billing/credit_grants',
      '/v1/billing/credit_grants',
      '/billing/credit_grants',
      '/v1/usage',
      '/usage'
    ];
    for (const path of quotaPaths) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
          const data = await res.json();
          // 兼容多种返回格式
          const total = data?.total_granted || data?.total || data?.quota || 500;
          const used = data?.total_used || data?.used || data?.usage || 0;
          if (total > 0) {
            return { used, total, remaining: total - used, percent: Math.min(100, Math.round((used / total) * 100)) };
          }
        }
      } catch {}
    }
    return { used: 0, total: null, remaining: null, percent: 0 };
  } catch {
    return { used: 0, total: null, remaining: null, percent: 0 };
  }
}

function providersState() {
  const state = loadWorkspaceState();
  const cfg = state.cfg;
  const displayNames = state.displayNames;
  const providers = cfg.models?.providers || {};
  const modelConfig = cfg.agents?.defaults?.model;
  const primary = typeof modelConfig === 'string' ? modelConfig : (modelConfig?.primary || '');
  return Object.entries(providers).map(([id, provider]) => ({
    id,
    displayName: displayNames[id]
      || (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string'
        ? String(provider.models[0].name).split(' / ')[0].trim()
        : id),
    baseUrl: provider?.baseUrl || '',
    models: Array.isArray(provider?.models) ? provider.models.length : 0,
    isPrimary: typeof primary === 'string' && primary.startsWith(`${id}/`),
  }));
}

function askFactory() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  const ask = (q) => new Promise((resolve) => {
    if (closed) {
      resolve('0');
      return;
    }
    rl.question(q, (a) => resolve(a.trim()));
  });
  ask.close = () => {
    if (!closed) rl.close();
  };
  return ask;
}

function runNode(script, args = [], options = {}) {
  const retry = options.retry === true;
  const label = options.label || path.basename(script || '子脚本');
  if (script && !fs.existsSync(script)) {
    warn(`缺少辅助脚本:${label}`);
    info('当前版本会尽量使用主脚本内建能力;如果你刚整理过文件,请确认 scripts 目录完整。');
    return 127;
  }
  let res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (retry && res.status !== 0) {
    info('首次同步失败,正在重试...');
    res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  }
  return typeof res.status === 'number' ? res.status : 1;
}

function resolveProviderKey(input, providers, displayNames) {
  if (!input) return null;
  if (providers[input]) return input;
  const lowered = String(input).toLowerCase();
  for (const key of Object.keys(providers || {})) {
    if (key.toLowerCase() === lowered) return key;
  }
  for (const [key, value] of Object.entries(displayNames || {})) {
    if (String(value).toLowerCase() === lowered && providers?.[key]) return key;
  }
  return null;
}

function isProviderRef(ref, name) {
  return typeof ref === 'string' && splitModelRef(ref)[0]?.toLowerCase() === String(name).toLowerCase();
}

function rewriteProviderRef(ref, oldName, newName) {
  if (!isProviderRef(ref, oldName)) return ref;
  const [, modelId] = splitModelRef(ref);
  return `${newName}/${modelId}`;
}

function rewriteProviderRefsInDefaults(config, oldName, newName) {
  const defaults = config.agents?.defaults;
  if (!defaults) return;

  const rewriteSelectionField = (fieldName) => {
    const value = defaults[fieldName];
    if (typeof value === 'string') {
      defaults[fieldName] = rewriteProviderRef(value, oldName, newName);
      return;
    }
    if (value && typeof value === 'object') {
      if (typeof value.primary === 'string') {
        value.primary = rewriteProviderRef(value.primary, oldName, newName);
      }
      if (Array.isArray(value.fallbacks)) {
        value.fallbacks = value.fallbacks.map((ref) => rewriteProviderRef(ref, oldName, newName));
      }
    }
  };

  rewriteSelectionField('model');
  rewriteSelectionField('imageModel');
  rewriteSelectionField('pdfModel');
  rewriteSelectionField('audioModel');
  rewriteSelectionField('videoGenerationModel');
  rewriteSelectionField('musicGenerationModel');
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

async function fetchProviderModelIds(baseUrlInput, apiKey) {
  const baseUrl = String(baseUrlInput || '').replace(/\/+$/, '');
  const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const res = await fetch(modelsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Failed to fetch models from ${modelsUrl}: HTTP ${res.status}`);
    err.detail = text.slice(0, 1000);
    throw err;
  }
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const ids = [...new Set(rows.map((x) => x?.id).filter(Boolean))];
  if (!ids.length) {
    throw new Error('No model IDs found in /models response');
  }
  return { ids, modelsUrl };
}

async function addProviderInline(providerName, providerDisplayName, baseUrlRaw, apiKey) {
  const state = loadWorkspaceState({ verbose: true });
  if (!state.ok) {
    danger(state.reason);
    info(state.hint);
    return { code: 1, exists: false };
  }
  const cfg = state.cfg;
  const displayNames = ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
  const baseUrl = String(baseUrlRaw || '').replace(/\/+$/, '');
  try {
    const { ids } = await fetchProviderModelIds(baseUrl, apiKey);
    displayNames[providerName] = providerDisplayName;
    writeJson(DISPLAY_NAMES, displayNames);
    cfg.models.providers[providerName] = {
      baseUrl,
      apiKey,
      api: 'openai-completions',
      models: ids.map((id) => normalizeModel(providerDisplayName, id)),
    };
    for (const id of ids) {
      const ref = `${providerName}/${id}`;
      if (!cfg.agents.defaults.models[ref]) cfg.agents.defaults.models[ref] = {};
    }
    const backup = createConfigBackup(`provider-${providerName}`);
    writeJson(CONFIG, cfg);
    console.log(`Added provider ${providerName}`);
    console.log(`Display name: ${providerDisplayName}`);
    console.log(`Config: ${CONFIG}`);
    console.log(`Base URL: ${baseUrl}`);
    console.log(`Models fetched: ${ids.length}`);
    console.log(`Backup: ${backup}`);
    console.log(`Display-name map: ${DISPLAY_NAMES}`);
    console.log('Sample models:');
    for (const id of ids.slice(0, 20)) console.log(`- ${providerName}/${id}`);
    return { code: 0, exists: true };
  } catch (err) {
    console.error(err.message);
    if (err.detail) console.error(err.detail);
    return { code: 2, exists: !!cfg.models?.providers?.[providerName] };
  }
}

async function syncProviderInline(providerInput) {
  const state = loadWorkspaceState({ verbose: true });
  if (!state.ok) {
    console.error(state.reason);
    console.error(state.hint);
    return 1;
  }
  const cfg = state.cfg;
  const providers = cfg.models?.providers || {};
  const displayNames = ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
  const providerName = resolveProviderKey(providerInput, providers, displayNames);
  const provider = providerName ? providers[providerName] : null;
  if (!provider || !providerName) {
    console.error(`Provider not found: ${providerInput}`);
    return 2;
  }
  if (!provider.baseUrl || !provider.apiKey) {
    console.error(`Provider ${providerName} is missing baseUrl or apiKey in config`);
    return 3;
  }
  try {
    const { ids } = await fetchProviderModelIds(provider.baseUrl, provider.apiKey);
    const backup = createConfigBackup(`manage-sync-${providerName}`);
    const displayName = displayNames[providerName] || providerName;
    provider.models = ids.map((id) => normalizeModel(displayName, id));
    const modelMap = cfg.agents.defaults.models || {};
    const wanted = new Set(ids.map((id) => `${providerName}/${id}`));
    let added = 0, removed = 0;
    for (const key of Object.keys(modelMap)) {
      const [pfx] = splitModelRef(key);
      if (pfx.toLowerCase() === providerName.toLowerCase() && !wanted.has(key)) {
        delete modelMap[key];
        removed += 1;
      }
    }
    for (const ref of wanted) {
      if (!modelMap[ref]) {
        modelMap[ref] = {};
        added += 1;
      }
    }
    writeJson(CONFIG, cfg);
    console.log(`Synced provider: ${providerName}`);
    console.log(`Display name: ${displayName}`);
    console.log(`Models now present: ${ids.length}`);
    console.log(`Added refs: ${added}`);
    console.log(`Removed stale refs: ${removed}`);
    console.log(`Backup: ${backup}`);
    console.log(`Display-name map: ${DISPLAY_NAMES}`);
    console.log('Now restart gateway: openclaw gateway restart');
    return 0;
  } catch (err) {
    console.error(err.message);
    if (err.detail) console.error(err.detail);
    return 4;
  }
}

function removeProviderInline(providerInput) {
  const state = loadWorkspaceState({ verbose: true });
  if (!state.ok) {
    console.error(state.reason);
    console.error(state.hint);
    return 1;
  }
  const cfg = state.cfg;
  const providers = cfg.models?.providers || {};
  const displayNames = ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
  const providerName = resolveProviderKey(providerInput, providers, displayNames);
  const provider = providerName ? providers[providerName] : null;
  if (!provider || !providerName) {
    console.error(`Provider not found: ${providerInput}`);
    return 2;
  }
  const modelConfig = cfg.agents?.defaults?.model;
  const currentPrimary = typeof modelConfig === 'string' ? modelConfig : modelConfig?.primary;
  if (typeof currentPrimary === 'string') {
    const [pfx] = splitModelRef(currentPrimary);
    if (pfx.toLowerCase() === providerName.toLowerCase()) {
      console.error(`Refusing to remove ${providerName}: default primary model is still using it (${currentPrimary})`);
      return 3;
    }
  }
  const modelMap = cfg.agents.defaults.models || {};
  const backup = createConfigBackup(`manage-remove-${providerName}`);
  delete cfg.models.providers[providerName];
  delete displayNames[providerName];
  writeJson(DISPLAY_NAMES, displayNames);
  let removed = 0;
  for (const key of Object.keys(modelMap)) {
    const [pfx] = splitModelRef(key);
    if (pfx.toLowerCase() === providerName.toLowerCase()) {
      delete modelMap[key];
      removed += 1;
    }
  }
  pruneModelSelection(cfg, providerName);
  writeJson(CONFIG, cfg);
  console.log(`Removed provider: ${providerName}`);
  console.log(`Removed refs: ${removed}`);
  console.log(`Backup: ${backup}`);
  console.log('Now restart gateway: openclaw gateway restart');
  return 0;
}

async function backPrompt(ask) {
  console.log(color('操作完成', C.green, C.bold));
  console.log(color('按任意键继续...', C.white, C.bold));
  while (true) {
    const ans = await ask('');
    if (ans === '0' || ans === '' || ans) return;
  }
}

function renderNumberedLine(num, label, note = '', options = {}) {
  const prefix = `${`${num}.`.padEnd(4, ' ')}`;
  const prefixTone = options.prefixTone || C.white;
  const labelTone = options.labelTone || C.white;
  const text = `${color(prefix, prefixTone, C.bold)}${color(label, labelTone, C.bold)}`;
  if (!note) return text;
  if (options.rawNote) return `${text}  ${note}`;
  const noteTone = options.noteTone || C.gray;
  return `${text}  ${color(note, noteTone)}`;
}


function printListScreen(title, rows = [], options = {}) {
  const {
    infoLine = '',
    zeroLabel = '返回上一级',
  } = options;
  const frameWidth = 39;
  const titleText = stripAnsi(title);
  const leftPad = Math.max(0, Math.floor((frameWidth - visibleLen(titleText)) / 2));
  console.log(color('=======================================', C.gray));
  console.log(color(`${' '.repeat(leftPad)}${title}`, C.white, C.bold));
  console.log(color('=======================================', C.gray));
  if (infoLine) console.log(color(`• ${infoLine}`, C.white, C.bold));
  console.log(color('---------------------------------------', C.gray));
  for (const row of rows) console.log(row);
  console.log(color('---------------------------------------', C.gray));
  console.log(`${color('0.  ', C.white, C.bold)}${zeroLabel}`);
  console.log(color('---------------------------------------', C.gray));
}

function renderScreenTitle(title, infoLine = '') {
  const frameWidth = 39;
  const titleText = stripAnsi(title);
  const leftPad = Math.max(0, Math.floor((frameWidth - visibleLen(titleText)) / 2));
  console.log(color('=======================================', C.gray));
  console.log(color(`${' '.repeat(leftPad)}${title}`, C.white, C.bold));
  console.log(color('=======================================', C.gray));
  if (infoLine) console.log(color(`• ${infoLine}`, C.white, C.bold));
}

function printInfoLines(lines = []) {
  console.log(color('---------------------------------------', C.gray));
  for (const line of lines) console.log(line);
  console.log(color('---------------------------------------', C.gray));
}

function printActionFooter(actions = [], options = {}) {
  const { blankLineBefore = false } = options;
  if (blankLineBefore) console.log('');
  console.log(color('---------------------------------------', C.gray));
  for (const action of actions) {
    const key = `${String(action.key ?? '').trim()}.`;
    const label = String(action.label ?? '');
    const hint = action.hint ? color(`  ${action.hint}`, C.gray) : '';
    console.log(`${color(key.padEnd(4, ' '), C.white, C.bold)}${color(label, C.white, C.bold)}${hint}`);
  }
  console.log(color('---------------------------------------', C.gray));
}

async function finishScreen(ask, lines = []) {
  if (lines.length) printInfoLines(lines);
  await backPrompt(ask);
}

async function chooseProvider(ask, prompt = '选择提供商编号: ', title = '已配置提供商') {
  const cfg = readJson(CONFIG, {});
  const rows = providersState();
  if (!rows.length) {
    warn('当前没有已配置的 API 提供商。');
    return null;
  }
  const statusMap = new Map();
  await mapWithConcurrency(rows, 3, async (row) => {
    const provider = cfg.models?.providers?.[row.id];
    const status = await detectProviderStatus(provider);
    statusMap.set(row.id, status);
  });
  while (true) {
    const listRows = rows.map((row, i) => {
      const status = statusMap.get(row.id) || {};
      const note = `${color(`${row.models}个模型`, C.yellow, C.bold)} | ${formatProviderStatusForProviderList(status)}${row.isPrimary ? ` | ${color('[默认]', C.yellow, C.bold)}` : ''}`;
      return renderNumberedLine(i + 1, formatProviderRow(row), note, { rawNote: true });
    });
    printListScreen(title, listRows, { infoLine: '正在检测 API 状态，请稍等...' });
    const answer = await ask(color('请输入你的选择: ', C.bold));
    if (answer === '0') return '__BACK__';
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx < 1 || idx > rows.length) {
      warn('编号无效,请重新输入。');
      continue;
    }
    return rows[idx - 1];
  }
}

async function switchDefaultModel(ask) {
  const cfg = readJson(CONFIG, null);
  if (!cfg) {
    danger(`读取配置失败: ${CONFIG}`);
    return;
  }

  while (true) {
    const chosenProvider = await chooseProvider(ask, '选择要切换到的提供商编号', '换模型');
    if (chosenProvider === '__BACK__') return;
    if (!chosenProvider) return;

    const fresh = readJson(CONFIG, {});
    const provider = fresh.models?.providers?.[chosenProvider.id];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    if (!models.length) {
      warn('当前服务商下没有模型,请先同步模型。');
      continue;
    }

    while (true) {
      const listRows = models.map((m, i) => {
        const ref = `${chosenProvider.id}/${m.id}`;
        const isCurrent = getCurrentModelRef() === ref;
        const label = m.name || m.id;
        const note = isCurrent ? `${color('[默认]', C.yellow, C.bold)}` : '';
        return renderNumberedLine(i + 1, label, note, { rawNote: true });
      });
      for (const row of listRows) console.log(row);
      printActionFooter([{ key: '0', label: '返回上一级' }], { blankLineBefore: false });
      const ans = await ask(color('请输入你的选择: ', C.bold));
      if (ans === '0') break;
      const idx = Number(ans);
      if (!Number.isInteger(idx) || idx < 1 || idx > models.length) {
        warn('编号无效,请重新输入。');
        continue;
      }
      const model = models[idx - 1];
    const modelStatus = provider ? await detectModelStatus(provider, model.id) : { online: false, latency: null, error: '未配置 provider' };
      console.log(`${color('• 模型检测结果:', C.white, C.bold)} ${formatModelCheckResultColored(modelStatus, { brief: true })}`);
      if (!(await confirmSwitchWhenModelCheckFailed(ask, modelStatus, () => provider ? detectModelStatus(provider, model.id, { timeoutMs: MODEL_STATUS_RETRY_TIMEOUT_MS, skipCache: true }) : Promise.resolve(modelStatus)))) {
        continue;
      }
      const ref = `${chosenProvider.id}/${model.id}`;
      const sessionSelection = await confirmSyncTelegramSessions(ask, ref);
      if (sessionSelection.action === 'cancelled') {
        warn('已取消本次模型切换,配置未修改。');
        await backPrompt(ask);
        continue;
      }
      const shouldUpdateDefault = !!sessionSelection.setDefaultOnly || !!sessionSelection.setDefaultToo;
      if (shouldUpdateDefault) {
        if (!fresh.agents) fresh.agents = {};
        if (!fresh.agents.defaults) fresh.agents.defaults = {};
        const existingModelConfig = fresh.agents.defaults.model;
        if (typeof existingModelConfig === 'string') {
          fresh.agents.defaults.model = { primary: ref };
        } else {
          if (!fresh.agents.defaults.model) fresh.agents.defaults.model = {};
          fresh.agents.defaults.model.primary = ref;
        }
        createConfigBackup('switch-model');
        fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2) + '\n');
      }
      addRecentModel(ref, `${formatProviderDisplay(chosenProvider.displayName, chosenProvider.id)} / ${model.id}`, chosenProvider.displayName);
      applySelectedSessionSync(sessionSelection, ref);
      if (shouldUpdateDefault) success(`默认模型已设为:${formatProviderDisplay(chosenProvider.displayName, chosenProvider.id)} / ${model.id}`);
      await backPrompt(ask);
      continue;
    }
  }
}

async function addProvider(ask) {
  renderScreenTitle('添加 API');
  const state = loadWorkspaceState({ verbose: true });
  if (!state.ok) {
    danger(state.reason);
    info(state.hint);
    await backPrompt(ask);
    return;
  }
  const providerName = await ask(color('输入 provider id（英文，唯一）：', C.bold));
  if (!providerName) return info('操作已取消。');
  const displayName = await ask(color('输入显示名称（中文可填，直接回车则同 provider id）：', C.bold)) || providerName;
  const baseUrl = await ask(color('输入 Base URL（例如 https://api.example.com/v1）：', C.bold));
  if (!baseUrl) return warn('Base URL 不能为空。');
  const apiKey = await ask(color('输入 API Key：', C.bold));
  if (!apiKey) return warn('API Key 不能为空。');
  const helperPath = path.join(__dirname, 'add-provider.mjs');
  const result = fs.existsSync(helperPath)
    ? { code: runNode(helperPath, [providerName, displayName, baseUrl, apiKey], { retry: true, label: 'add-provider.mjs' }) }
    : await addProviderInline(providerName, displayName, baseUrl, apiKey);
  const freshCfg = loadWorkspaceState().cfg;
  const exists = !!freshCfg.models?.providers?.[providerName];
  if (exists && result.code === 0) {
    success(fs.existsSync(helperPath) ? 'API 添加成功,模型同步完成。' : 'API 添加成功,已由主脚本完成模型同步。');
    success('配置已更新。');
  } else if (exists) {
    warn('模型同步失败,请核对 Base URL / API Key 后再手动同步。');
    info('API 配置已保存。请查看上方报错详情(例如 HTTP 401/403/500、/models 返回为空等)。');
  } else {
    danger('API 添加失败,配置未成功写入。');
  }
  await backPrompt(ask);
  return;
}

async function removeProvider(ask) {
  while (true) {
    const row = await chooseProvider(ask, '选择要删除的提供商编号', '删除 API');
    if (row === '__BACK__') return;
    if (!row) return;
    const freshCfg = readJson(CONFIG, {});
    const primaryRef = getCurrentModelRef();
    const provider = freshCfg.models?.providers?.[row.id];
    const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
    const isCurrentProvider = typeof primaryRef === 'string' && primaryRef.startsWith(`${row.id}/`);

    section(`删除 ${formatProviderRow(row)}`);
    console.log(`${color('模型数量', C.gray)}  ${color(`${modelCount} 个`, C.yellow, C.bold)}`);
    if (isCurrentProvider) {
      warn('该 API 当前正被默认模型使用,删除后默认模型可能失效。');
    }
    const confirm = await ask(color(`确认删除 API ${formatProviderRow(row)}？(y/N): `, C.yellow, C.bold));
    if (confirm.toLowerCase() !== 'y') {
      info('操作已取消。');
      continue;
    }
    const status = fs.existsSync(path.join(__dirname, 'provider-manage.mjs'))
      ? runNode(path.join(__dirname, 'provider-manage.mjs'), ['remove', row.id], { label: 'provider-manage.mjs' })
      : removeProviderInline(row.id);
    const latestCfg = readJson(CONFIG, {});
    const exists = !!latestCfg.models?.providers?.[row.id];
    if (status === 0 && !exists) {
      success('API 删除成功。');
      if (isCurrentProvider) {
        warn('原默认模型所属 provider 已删除,请尽快重新选择默认模型。');
      }
      success('配置已更新。');
    } else {
      danger(`API 删除失败:${row.displayName},请检查配置或重试。`);
      info('请查看上方报错详情;如果它正被当前默认主模型使用,脚本可能会直接拒绝删除。');
    }
    await backPrompt(ask);
    continue;
  }
}

async function syncAllProviders(ask) {
  const rows = providersState();
  if (!rows.length) {
    warn('当前没有已配置的 API 提供商。');
    return;
  }
  const beforeCfg = readJson(CONFIG, {});
  const beforeCounts = new Map(rows.map((row) => [row.id, Array.isArray(beforeCfg.models?.providers?.[row.id]?.models) ? beforeCfg.models.providers[row.id].models.length : 0]));
  const beforeIdsMap = new Map(rows.map((row) => [row.id, getProviderModelIds(beforeCfg, row.id)]));
  info(`开始同步全部 ${rows.length} 个 API，请稍等...`);
  let successCount = 0, failCount = 0;
  const detailLines = [];
  for (const [idx, row] of rows.entries()) {
    console.log('');
    console.log(`${progressBar(idx+1, rows.length)} 正在同步 ${row.displayName}...`);
    const status = fs.existsSync(path.join(__dirname, 'provider-manage.mjs'))
      ? runNode(path.join(__dirname, 'provider-manage.mjs'), ['sync', row.id], { label: 'provider-manage.mjs' })
      : await syncProviderInline(row.id);
    const freshCfg = readJson(CONFIG, {});
    const before = beforeCounts.get(row.id) ?? 0;
    const after = Array.isArray(freshCfg.models?.providers?.[row.id]?.models) ? freshCfg.models.providers[row.id].models.length : 0;
    const beforeIds = beforeIdsMap.get(row.id) || [];
    const afterIds = getProviderModelIds(freshCfg, row.id);
    const { added, removed } = formatModelDelta(beforeIds, afterIds);
    if (status === 0) {
      successCount++;
      detailLines.push(color(`✅ ${formatProviderRow(row)}: 新增 ${added.length} 个,删除 ${removed.length} 个,当前 ${after} 个`, C.white));
      for (const line of formatModelListBlock('➕', '新增模型', added)) detailLines.push(color(line, C.white));
      for (const line of formatModelListBlock('➖', '删除模型', removed)) detailLines.push(color(line, C.white));
    } else {
      failCount++;
      detailLines.push(color(`⚠️ ${formatProviderRow(row)}: /models 探测失败`, C.white));
      detailLines.push(color(`新增 0 个,删除 0 个,当前 ${after} 个`, C.white));
    }
  }
  const afterCfg = readJson(CONFIG, {});
  let addedTotal = 0, removedTotal = 0, unchangedProviders = 0;
  for (const row of rows) {
    const before = beforeCounts.get(row.id) || 0;
    const after = Array.isArray(afterCfg.models?.providers?.[row.id]?.models) ? afterCfg.models.providers[row.id].models.length : 0;
    if (after > before) addedTotal += (after - before);
    else if (after < before) removedTotal += (before - after);
    else unchangedProviders++;
  }
  success(`全部同步完成：成功 ${successCount} 个，失败 ${failCount} 个。`);
  console.log(color(`同步摘要:共检查 ${rows.length} 个提供商,新增 ${addedTotal} 个模型,移除 ${removedTotal} 个模型,${unchangedProviders} 个提供商模型数未变化。`, C.white));
  if (detailLines.length) {
    for (const line of detailLines) console.log(line);
  }
  if (failCount > 0) {
    info('若有失败,请查看上方对应 API 的报错详情(常见原因:Base URL 错误、API Key 无效、/models 接口异常、返回空模型列表)。');
  }
  success('配置已更新。');
  const restartAns = await ask(color('需要重启 Gateway 让新模型生效？(y/N): ', C.yellow, C.bold));
  if (restartAns.toLowerCase() === 'y') {
    await restartGateway(ask);
    return;
  }
  await backPrompt(ask);
}

async function syncProvider(ask) {
  while (true) {
    const cfg = readJson(CONFIG, {});
    const rows = providersState();
    if (!rows.length) {
      warn('当前没有已配置的 API 提供商。');
      return null;
    }
    const statusMap = new Map();
    await mapWithConcurrency(rows, 3, async (row) => {
      const provider = cfg.models?.providers?.[row.id];
      const status = await detectProviderStatus(provider);
      statusMap.set(row.id, status);
    });
    const listRows = rows.map((row, i) => {
      const status = statusMap.get(row.id) || {};
      const note = `${color(`${row.models}个模型`, C.yellow, C.bold)} | ${formatProviderStatusForProviderList(status)}${row.isPrimary ? ` | ${color('[默认]', C.yellow, C.bold)}` : ''}`;
      return renderNumberedLine(i + 1, formatProviderRow(row), note, { rawNote: true });
    });
    renderScreenTitle('同步模型', '正在检测 API 状态，请稍等...');
    console.log(color('---------------------------------------', C.gray));
    for (const row of listRows) console.log(row);
    console.log(color('---------------------------------------', C.gray));
    console.log(`${color('a.  ', C.white, C.bold)}全部同步`);
    console.log(`${color('0.  ', C.white, C.bold)}返回上一级`);
    console.log(color('---------------------------------------', C.gray));
    const allSyncNo = 'a';
    const answer = (await ask(color('请输入你的选择: ', C.bold))).toLowerCase();
    if (answer === '0') return '__BACK__';
    if (answer === 'a') {
      await syncAllProviders(ask);
      continue;
    }
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx < 1 || idx > rows.length) {
      warn('编号无效,请重新输入。');
      continue;
    }
    const row = rows[idx - 1];
    const beforeCfg = readJson(CONFIG, {});
    const beforeCount = Array.isArray(beforeCfg.models?.providers?.[row.id]?.models) ? beforeCfg.models.providers[row.id].models.length : 0;
    const status = fs.existsSync(path.join(__dirname, 'provider-manage.mjs'))
      ? runNode(path.join(__dirname, 'provider-manage.mjs'), ['sync', row.id], { label: 'provider-manage.mjs' })
      : await syncProviderInline(row.id);
    if (status === 0) {
      const afterCfg = readJson(CONFIG, {});
      const afterCount = Array.isArray(afterCfg.models?.providers?.[row.id]?.models) ? afterCfg.models.providers[row.id].models.length : 0;
      const beforeIds = getProviderModelIds(beforeCfg, row.id);
      const afterIds = getProviderModelIds(afterCfg, row.id);
      const { added, removed } = formatModelDelta(beforeIds, afterIds);
      success(`✅ ${formatProviderRow(row)}: 新增 ${added.length} 个,删除 ${removed.length} 个,当前 ${afterCount} 个`);
      for (const line of formatModelListBlock('➕', '新增模型', added)) console.log(color(line, C.white));
      for (const line of formatModelListBlock('➖', '删除模型', removed)) console.log(color(line, C.white));
      success('配置已更新。');
    } else {
      danger(`⚠️ ${formatProviderRow(row)}: /models 探测失败,请检查日志或配置后重试。`);
      info('请查看上方报错详情(常见原因:Base URL 错误、API Key 无效、/models 接口异常、返回空模型列表)。');
    }
    await backPrompt(ask);
    continue;
  }
}

async function modifyProvider(ask) {
  while (true) {
    const cfg = readJson(CONFIG, null);
    if (!cfg) {
      danger(`读取配置失败: ${CONFIG}`);
      return;
    }
    const row = await chooseProvider(ask, '选择要修改配置的 API 提供商编号', '修改 API 配置');
    if (row === '__BACK__') return;
    if (!row) return;

    let provider = cfg.models?.providers?.[row.id];
    if (!provider) {
      danger(`未找到 API:${row.displayName} (${row.id}),请刷新后重试。`);
      continue;
    }

    while (true) {
      const listRows = [
        renderNumberedLine(1, '修改英文 ID(provider id)'),
        renderNumberedLine(2, '修改显示名称(中文显示名)'),
        renderNumberedLine(3, '修改 Base URL'),
        renderNumberedLine(4, '修改 API Key'),
        renderNumberedLine(5, '同时修改全部'),
      ];
      printListScreen(`修改 ${formatProviderRow(row)} 的配置`, listRows, { zeroLabel: '返回上一级' });
      const action = await ask(color('请输入你的选择: ', C.bold));
      if (action === '0') break;
      if (!['1', '2', '3', '4', '5'].includes(action)) {
        warn('编号无效,请重新输入。');
        continue;
      }

      const displayNames = ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
      let newProviderId = row.id;
      let newDisplayName = row.displayName;
      let newBaseUrl = provider.baseUrl;
      let newApiKey = provider.apiKey;

      if (action === '1' || action === '5') {
        console.log('');
        const input = await ask(color(`当前英文 ID: ${row.id}\n请输入新的英文 ID(直接回车保持不变): `, C.bold));
        newProviderId = input.trim() ? input.trim() : row.id;
      }
      if (action === '2' || action === '5') {
        console.log('');
        const input = await ask(color(`当前中文显示名: ${row.displayName}\n请输入新的中文显示名(直接回车保持不变): `, C.bold));
        newDisplayName = input.trim() ? input.trim() : row.displayName;
      }
      if (action === '3' || action === '5') {
        console.log('');
        const input = await ask(color(`当前 Base URL： ${provider.baseUrl}\n请输入新的 Base URL（直接回车保持不变）：`, C.bold));
        newBaseUrl = input.trim() ? input.trim() : provider.baseUrl;
      }
      if (action === '4' || action === '5') {
        console.log('');
        const maskedKey = typeof provider.apiKey === 'string' && provider.apiKey.length
          ? `${provider.apiKey.slice(0, 10)}...`
          : '未设置';
        const input = await ask(color(`当前 API Key： ${maskedKey}\n请输入新的 API Key（直接回车保持不变）：`, C.bold));
        newApiKey = input.trim() ? input.trim() : provider.apiKey;
      }

      console.log('');
      const confirm = await ask(color(`确认修改 API 配置？(y/N): `, C.yellow, C.bold));
      if (confirm.toLowerCase() !== 'y') {
        info('操作已取消。');
        continue;
      }

      const backup = createConfigBackup(`modify-${row.id}`);

      const oldProviderId = row.id;
      const providerIdChanged = newProviderId && newProviderId !== oldProviderId;
      if (providerIdChanged) {
        const providers = cfg.models.providers || {};
        if (providers[newProviderId]) {
          danger(`新的英文 ID 已存在:${newProviderId}`);
          continue;
        }
        providers[newProviderId] = providers[oldProviderId];
        delete providers[oldProviderId];
        const modelRefs = cfg.agents?.defaults?.models || {};
        for (const key of Object.keys(modelRefs)) {
          if (key.startsWith(`${oldProviderId}/`)) {
            const suffix = key.slice(oldProviderId.length + 1);
            modelRefs[`${newProviderId}/${suffix}`] = modelRefs[key];
            delete modelRefs[key];
          }
        }
        rewriteProviderRefsInDefaults(cfg, oldProviderId, newProviderId);
        if (displayNames[oldProviderId] !== undefined) {
          displayNames[newProviderId] = displayNames[oldProviderId];
          delete displayNames[oldProviderId];
        }
        row.id = newProviderId;
        provider = cfg.models.providers[newProviderId];
      }

      const oldBaseUrl = provider.baseUrl;
      const oldApiKey = provider.apiKey;
      provider.baseUrl = newBaseUrl;
      provider.apiKey = newApiKey;
      displayNames[row.id] = newDisplayName;
      writeJson(DISPLAY_NAMES, displayNames);

      if (Array.isArray(provider.models)) {
        provider.models = provider.models.map((model) => ({
          ...model,
          name: `${newDisplayName} / ${model.id}`,
        }));
      }

      writeJson(CONFIG, cfg);
      const checked = await detectProviderStatus(provider);
      success(`API 配置修改成功。`);
      info(`修改后检测:${stripAnsi(formatProviderStatusCompact(checked))}`);
      const shouldSyncModels = String(oldBaseUrl || '') !== String(newBaseUrl || '') || String(oldApiKey || '') !== String(newApiKey || '');
      if (shouldSyncModels) {
        info('检测到 Base URL 或 API Key 已变更，正在自动同步模型列表...');
        const beforeCfg = readJson(CONFIG, {});
        const beforeIds = getProviderModelIds(beforeCfg, row.id);
        const syncStatus = fs.existsSync(path.join(__dirname, 'provider-manage.mjs'))
          ? runNode(path.join(__dirname, 'provider-manage.mjs'), ['sync', row.id], { label: 'provider-manage.mjs' })
          : await syncProviderInline(row.id);
        const afterCfg = readJson(CONFIG, {});
        const afterIds = getProviderModelIds(afterCfg, row.id);
        const { added, removed } = formatModelDelta(beforeIds, afterIds);
        if (syncStatus === 0) {
          success(`模型同步完成：新增 ${added.length} 个，删除 ${removed.length} 个，当前 ${afterIds.length} 个。`);
          for (const line of formatModelListBlock('➕', '新增模型', added)) console.log(color(line, C.white));
          for (const line of formatModelListBlock('➖', '删除模型', removed)) console.log(color(line, C.white));
        } else {
          warn('模型自动同步失败，API 配置已保存；请稍后在 [4] 同步 API 里手动同步。');
        }
      }
      success('配置已更新。');
      const restartMod = await ask(color('需要重启 Gateway 让新模型生效？(y/N): ', C.yellow, C.bold));
      if (restartMod.toLowerCase() === 'y') {
        await restartGateway(ask);
        return;
      }
      await backPrompt(ask);
      break;
    }
    continue;
  }
}

async function showProvidersDetail(ask) {
  renderScreenTitle('查看 API 列表', '正在检测 API 状态，请稍等...');
  const cfg = readJson(CONFIG, {});
  const rows = providersState();
  if (!rows.length) {
    warn('当前没有已配置的 API 提供商。');
    await backPrompt(ask);
    return;
  }

  const detailRows = [];
  for (const row of rows) {
    const provider = cfg.models?.providers?.[row.id];
    const status = await detectProviderStatus(provider);
    detailRows.push({ row, provider, status });
  }

  const lines = detailRows.map(({ row, status }, i) => {
    const name = formatProviderRow(row);
    const url = maskUrl(row.baseUrl);
    const modelText = color(`${row.models}个模型`, C.yellow, C.bold);
    const stateText = status?.online ? color('在线', C.green, C.bold) : color('离线', C.red, C.bold);
    const latencyText = status?.online && status?.latency
      ? color(`${status.latency}ms`, status.latency < 200 ? C.green : status.latency < 500 ? C.yellow : C.magenta, C.bold)
      : color(status?.error || '不可用', C.gray);
    const currentTag = row.isPrimary ? ` | ${color('[默认]', C.yellow, C.bold)}` : '';
    return renderNumberedLine(i + 1, `${name} | ${url}`, `${modelText} | ${stateText} | ${latencyText}${currentTag}`, { rawNote: true });
  });

  printInfoLines(lines);
  await backPrompt(ask);
}

async function quickSwitchFavorite(ask) {
  const currentRef = getCurrentModelRef();
  const cfg = readJson(CONFIG, {});
  const providers = cfg.models?.providers || {};
  let recentRaw = readRecentModels();
  if (!recentRaw.length) {
    seedRecentModelsFromCurrentDefault();
    recentRaw = readRecentModels();
  }
  const recent = [];

  for (const item of recentRaw) {
    const [providerId, modelId] = splitModelRef(item.ref);
    const provider = providers[providerId];
    if (!provider || !Array.isArray(provider.models)) continue;
    const exists = provider.models.some(m => m.id === modelId);
    if (exists) {
      recent.push(item);
    }
  }
  if (recent.length !== recentRaw.length) {
    writeRecentModels(recent);
  }

  if (!recent.length) {
    warn('还没有常用模型,先去 [1] 换模型一次就会自动记录。');
    await backPrompt(ask);
    return;
  }

  const modelStatusMap = new Map();
  const providerStatusMap = new Map();
  const providerEntries = [...new Set(recent.map((item) => splitModelRef(item.ref)[0]))].map((providerId) => ({
    providerId,
    provider: providers[providerId],
  }));

  await mapWithConcurrency(providerEntries, 3, async ({ providerId, provider }) => {
    if (provider && provider.baseUrl && provider.apiKey) {
      providerStatusMap.set(providerId, await detectProviderStatus(provider));
    } else {
      providerStatusMap.set(providerId, { online: false, latency: null, error: '未配置 provider' });
    }
  });

  await mapWithConcurrency(recent, 3, async (item) => {
    const [providerId, modelId] = splitModelRef(item.ref);
    const provider = providers[providerId];
    if (provider && provider.baseUrl && provider.apiKey) {
      modelStatusMap.set(item.ref, await detectModelStatus(provider, modelId));
    } else {
      modelStatusMap.set(item.ref, { status: 'failed', online: false, latency: null, error: '未配置 provider' });
    }
  });

  const renderQuickSwitchFavoriteScreen = () => {
    const orderIndexMap = new Map(recent.map((item, idx) => [item.ref, idx]));
    const orderedRecent = [...recent].sort((a, b) => {
      const aStatus = modelStatusMap.get(a.ref)?.status === 'available' ? 1 : 0;
      const bStatus = modelStatusMap.get(b.ref)?.status === 'available' ? 1 : 0;
      if (aStatus !== bStatus) return bStatus - aStatus;
      return (orderIndexMap.get(a.ref) ?? 9999) - (orderIndexMap.get(b.ref) ?? 9999);
    });
    renderScreenTitle('常用模型', '正在检测常用模型可用性，请稍等...');
    console.log(color('---------------------------------------', C.gray));
    let insertedSplit = false;
    orderedRecent.forEach((item, i) => {
      const [providerId, modelId] = splitModelRef(item.ref);
      const modelStatus = modelStatusMap.get(item.ref) || { status: 'failed', online: false, latency: null, error: '未检测' };
      const providerStatus = providerStatusMap.get(providerId) || { online: false, latency: null, error: '未检测 provider' };
      const providerLabel = String(item.provider || providerId).trim();
      const isAvailable = modelStatus.status === 'available';
      if (!isAvailable && !insertedSplit && i > 0) {
        console.log('');
        insertedSplit = true;
      }
      const note = `${formatProviderStatusForProviderList(providerStatus)} | ${formatModelCheckResultColored(modelStatus)}${item.ref === currentRef ? ` | ${color('[默认]', C.yellow, C.bold)}` : ''}`;
      console.log(renderNumberedLine(i + 1, `${providerLabel}(${providerId}) / ${modelId}`, note, { rawNote: true }));
    });
    printActionFooter([
      { key: 'd', label: '删除常用模型' },
      { key: '0', label: '返回上一级' },
    ]);
    return orderedRecent;
  };

  let orderedRecent = [];

  while (true) {
    orderedRecent = renderQuickSwitchFavoriteScreen();
    const answer = (await ask(color('请输入你的选择: ', C.bold))).toLowerCase();
    if (answer === '0') return;
    if (answer === 'd') {
      const deleteAnswer = await ask(color('输入要删除的常用模型编号,支持空格分隔批量删除(0取消): ', C.yellow, C.bold));
      if (deleteAnswer === '0') continue;
      const deleteIdxs = deleteAnswer.trim().split(/\s+/).map((str) => Number(str)).filter((num) => Number.isInteger(num) && num >=1 && num <= orderedRecent.length);
      if (deleteIdxs.length === 0) {
        warn('编号无效,请重新输入。');
        continue;
      }
      const deletedRefs = new Set(deleteIdxs.map((idx) => orderedRecent[idx -1].ref));
      const remain = recent.filter((item) => !deletedRefs.has(item.ref));
      recent.splice(0, recent.length, ...remain);
      writeRecentModels(recent);
      deletedRefs.forEach((ref) => modelStatusMap.delete(ref));
      success(`已删除 ${deletedRefs.size} 个常用模型`);
      await backPrompt(ask);
      continue;
    }
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx <1 || idx > orderedRecent.length) {
      warn('编号无效,请重新输入。');
      continue;
    }
    const selected = orderedRecent[idx-1];
    const [providerId, modelId] = splitModelRef(selected.ref);
    const provider = providers[providerId];
    const modelStatus = modelStatusMap.get(selected.ref)
      || (provider ? await detectModelStatus(provider, modelId) : { online: false, latency: null, error: '未配置 provider' });
    if (!(await confirmSwitchWhenModelCheckFailed(ask, modelStatus, async () => {
      const freshStatus = provider ? await detectModelStatus(provider, modelId, { timeoutMs: MODEL_STATUS_RETRY_TIMEOUT_MS, skipCache: true }) : modelStatus;
      modelStatusMap.set(selected.ref, freshStatus);
      return freshStatus;
    }))) {
      continue;
    }
    const sessionSelection = await confirmSyncTelegramSessions(ask, selected.ref);
    if (sessionSelection.action === 'cancelled') {
      warn('已取消本次模型切换,配置未修改。');
      await backPrompt(ask);
      continue;
    }
    const shouldUpdateDefault = !!sessionSelection.setDefaultOnly || !!sessionSelection.setDefaultToo;
    if (shouldUpdateDefault) {
      const fresh = readJson(CONFIG, {});
      if (!fresh.agents) fresh.agents = {};
      if (!fresh.agents.defaults) fresh.agents.defaults = {};
      const existingModelConfig = fresh.agents.defaults.model;
      if (typeof existingModelConfig === 'string') {
        fresh.agents.defaults.model = { primary: selected.ref };
      } else {
        if (!fresh.agents.defaults.model) fresh.agents.defaults.model = {};
        fresh.agents.defaults.model.primary = selected.ref;
      }
      createConfigBackup('recent-switch');
      writeJson(CONFIG, fresh);
    }

    addRecentModel(selected.ref, selected.name, selected.provider);

    applySelectedSessionSync(sessionSelection, selected.ref);
    if (shouldUpdateDefault) success(`默认模型已设为:${formatProviderDisplay(selected.provider || providerId, providerId)} / ${modelId}`);
    await backPrompt(ask);
    continue;
  }
}

async function searchModelsGlobally(ask) {
  const currentRef = getCurrentModelRef();
  const cfg = readJson(CONFIG, {});
  const providers = cfg.models?.providers || {};
  const displayNames = readJson(DISPLAY_NAMES, {});
  const allModels = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    const providerDisplayName = displayNames[providerId]
      || (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string'
        ? String(provider.models[0].name).split(' / ')[0].trim()
        : providerId);
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      allModels.push({
        providerId,
        providerDisplayName,
        id: model.id,
        name: model.name || model.id,
        ref: `${providerId}/${model.id}`,
      });
    }
  }

  if (!allModels.length) {
    warn('当前没有可搜索的模型,请先添加并同步 API。');
    await backPrompt(ask);
    return;
  }

  while (true) {
    renderScreenTitle('搜索模型');
    console.log(color('支持全局搜索模型、模型ID、服务商名称关键词', C.gray));
    console.log('');
    console.log(color('---------------------------------------', C.gray));
    console.log(`${color('0.  ', C.white, C.bold)}返回上一级`);
    console.log(color('---------------------------------------', C.gray));
    const keyword = await ask(color('请输入搜索关键词(输入后按回车): ', C.bold));
    if (keyword === '0') return;
    const q = keyword.trim().toLowerCase();
    if (!q) {
      warn('关键词不能为空,请重新输入。');
      continue;
    }

    const matches = allModels.filter((item) => {
      return item.name.toLowerCase().includes(q)
        || item.id.toLowerCase().includes(q)
        || item.providerDisplayName.toLowerCase().includes(q)
        || item.providerId.toLowerCase().includes(q);
    });

    if (!matches.length) {
      warn(`没有找到包含"${keyword}"的模型。`);
      continue;
    }

    while (true) {
      const visibleMatches = matches.slice(0, 100);
      const statusMap = new Map();
      const providerIds = [...new Set(visibleMatches.map((item) => item.providerId))];
      await mapWithConcurrency(providerIds, 3, async (providerId) => {
        const provider = providers[providerId];
        statusMap.set(providerId, await detectProviderStatus(provider));
      });
      const listRows = visibleMatches.map((item, i) => {
        const status = statusMap.get(item.providerId) || { online: false, latency: null };
        const note = `${formatProviderStatusCompact(status)}${item.ref === currentRef ? ` | ${color('[默认]', C.yellow, C.bold)}` : ''}`;
        return renderNumberedLine(i + 1, `${formatProviderDisplay(item.providerDisplayName, item.providerId)} / ${item.id}`, note, { rawNote: true });
      });
      printListScreen(`搜索结果:${keyword}`, listRows, { infoLine: '支持全局搜索模型、模型ID、服务商名称关键词' });
      const cachedCount = [...statusMap.values()].filter((status) => status?._cached).length;
      if (cachedCount > 0) {
        info(`已复用 ${cachedCount} 个服务商的延迟缓存(30 秒内)。`);
      }
      if (matches.length > 100) {
        info(`结果较多,仅显示前 100 条,共 ${matches.length} 条。`);
      }
      const answer = await ask(color('请输入你的选择: ', C.bold));
      if (answer === '0') break;
      const idx = Number(answer);
      if (!Number.isInteger(idx) || idx < 1 || idx > visibleMatches.length) {
        warn('编号无效,请重新输入。');
        continue;
      }

      const selected = visibleMatches[idx - 1];
      const provider = providers[selected.providerId];
      const modelStatus = provider ? await detectModelStatus(provider, selected.id) : { online: false, latency: null, error: '未配置 provider' };
      console.log(formatModelCheckResultColored(modelStatus));
      if (!(await confirmSwitchWhenModelCheckFailed(ask, modelStatus, () => provider ? detectModelStatus(provider, selected.id, { timeoutMs: MODEL_STATUS_RETRY_TIMEOUT_MS, skipCache: true }) : Promise.resolve(modelStatus)))) {
        continue;
      }

      const sessionSelection = await confirmSyncTelegramSessions(ask, selected.ref);
      if (sessionSelection.action === 'cancelled') {
        warn('已取消本次模型切换,配置未修改。');
        await backPrompt(ask);
        continue;
      }
      const shouldUpdateDefault = !!sessionSelection.setDefaultOnly || !!sessionSelection.setDefaultToo;
      if (shouldUpdateDefault) {
        const fresh = readJson(CONFIG, {});
        if (!fresh.agents) fresh.agents = {};
        if (!fresh.agents.defaults) fresh.agents.defaults = {};
        const existingModelConfig = fresh.agents.defaults.model;
        if (typeof existingModelConfig === 'string') {
          fresh.agents.defaults.model = { primary: selected.ref };
        } else {
          if (!fresh.agents.defaults.model) fresh.agents.defaults.model = {};
          fresh.agents.defaults.model.primary = selected.ref;
        }
        createConfigBackup('search-switch');
        writeJson(CONFIG, fresh);
      }
      addRecentModel(selected.ref, `${formatProviderDisplay(selected.providerDisplayName, selected.providerId)} / ${selected.id}`, selected.providerDisplayName);
      applySelectedSessionSync(sessionSelection, selected.ref);
      if (shouldUpdateDefault) success(`默认模型已设为:${formatProviderDisplay(selected.providerDisplayName, selected.providerId)} / ${selected.id}`);
      await backPrompt(ask);
      return;
    }
  }
}

function getLatestOpenClawVersion(force = false) {
  if (!force && menuRuntimeCache.latestVersion.value && Date.now() - menuRuntimeCache.latestVersion.ts < LATEST_VERSION_CACHE_TTL_MS) {
    return menuRuntimeCache.latestVersion.value;
  }
  try {
    const res = runCommand('npm', ['view', 'openclaw', 'version'], { timeout: 5000 });
    const value = (res.stdout || '').trim() || (res.stderr || '').trim() || '未知';
    menuRuntimeCache.latestVersion = { value, ts: Date.now() };
    return value;
  } catch {
    return menuRuntimeCache.latestVersion.value || '未知';
  }
}

function getOpenClawVersionChoices(currentVersionFull) {
  const currentVersion = extractOpenClawVersion(currentVersionFull, currentVersionFull);
  const latestVersion = getLatestOpenClawVersion();
  const choices = [];
  const seen = new Set();

  const isStableVersion = (version) => /^\d{4}\.\d+\.\d+$/.test(String(version || '').trim());
  const compareVersionsDesc = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  const allStable = [];
  const pushRaw = (version) => {
    const normalized = String(version || '').trim();
    if (!normalized || normalized === '未知' || seen.has(normalized) || !isStableVersion(normalized)) return;
    seen.add(normalized);
    allStable.push(normalized);
  };

  pushRaw(latestVersion);
  pushRaw(currentVersion);

  try {
    const res = runCommand('npm', ['view', 'openclaw', 'versions', '--json'], { timeout: 8000 });
    const raw = `${res.stdout || ''}${res.stderr || ''}`.trim();
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.filter((v) => isStableVersion(v)).forEach((v) => pushRaw(v));
      }
    }
  } catch {}

  allStable.sort(compareVersionsDesc);

  for (const version of allStable.slice(0, 6)) {
    let label = '';
    if (version === latestVersion && version === currentVersion) label = '最新版本 / 当前版本';
    else if (version === latestVersion) label = '最新版本';
    else if (version === currentVersion) label = '当前版本';
    choices.push({ version, label });
  }

  return choices;
}

function summarizeGatewayStatusOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, summary: '未获取到状态输出。' };
  const normalized = raw.toLowerCase();
  const runtimeRunning = /runtime:\s*running/i.test(raw);
  const listening = /listening:/i.test(raw);
  const probeOk = /connectivity probe:\s*(ok|ready|passed|success)/i.test(raw);
  const probeFailed = /connectivity probe:\s*failed/i.test(raw);

  if (runtimeRunning && (probeOk || listening) && !/main process exited|failed with result|status=1\/failure/i.test(raw)) {
    return { ok: true, summary: 'Gateway 运行中，端口已监听。' };
  }
  if (probeFailed && listening) {
    return { ok: true, summary: 'Gateway 进程在运行，端口已监听；通常再等几秒即可。' };
  }
  if (/gateway not running|runtime:\s*stopped|connect econnrefused|timeout|econnreset/i.test(normalized)) {
    return { ok: false, summary: 'Gateway 仍未完全就绪，请查看状态输出与日志。' };
  }
  return { ok: runtimeRunning || listening, summary: runtimeRunning || listening ? 'Gateway 似乎已启动，但建议再检查一次状态。' : '未确认 Gateway 已正常启动。' };
}

function inspectGatewayStatus(options = {}) {
  const force = options.force === true;
  if (!force && menuRuntimeCache.gatewayStatus.value && Date.now() - menuRuntimeCache.gatewayStatus.ts < GATEWAY_MENU_CACHE_TTL_MS) {
    return menuRuntimeCache.gatewayStatus.value;
  }
  const res = runCommand('openclaw', ['gateway', 'status'], { timeout: 12000 });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const value = {
    status: res.status,
    output,
    ...summarizeGatewayStatusOutput(output),
  };
  menuRuntimeCache.gatewayStatus = { value, ts: Date.now() };
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForGatewayReady(options = {}) {
  const {
    startMessage = '正在检查 Gateway 状态...',
    retryMessage = '第 {attempt} 次状态检查尚未拿到结果,正在重试...',
  } = options;
  info(startMessage);
  let inspected = { status: 1, output: '', ok: false, summary: '未获取到状态输出。' };
  for (let attempt = 1; attempt <= GATEWAY_RESTART_CHECK_MAX_ATTEMPTS; attempt++) {
    inspected = inspectGatewayStatus({ force: true });
    if (inspected.ok) break;
    if (attempt < GATEWAY_RESTART_CHECK_MAX_ATTEMPTS) {
      info(retryMessage.replace('{attempt}', String(attempt)));
      await sleep(GATEWAY_RESTART_CHECK_INTERVAL_MS);
    }
  }
  return inspected;
}

function inspectGatewayLogs(limit = 80) {
  const res = runCommand('journalctl', ['--user', '-u', 'openclaw-gateway.service', '-n', String(limit), '--no-pager'], { timeout: 12000 });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

function diagnoseGateway(statusOutput, logOutput) {
  const statusText = String(statusOutput || '');
  const logText = String(logOutput || '');
  const merged = `${statusText}\n${logText}`;

  if (/deactivating|restarting|received SIGTERM; restarting|draining .* before restart|config change requires channel reload|restarting telegram channel|starting provider/i.test(merged)) {
    return {
      title: 'Gateway 正在重启 / 重载中',
      summary: '检测到 Gateway 或 Telegram 通道正在重启、排空任务或重载配置,这通常是临时过渡状态。',
      suggestion: '建议稍等几十秒后重新检查;如长时间未恢复,再查看日志或执行 openclaw doctor。',
    };
  }
  if (/CIAO PROBING CANCELLED|bonjour: watchdog|service stuck in probing|Unhandled promise rejection: CIAO PROBING CANCELLED/i.test(merged)) {
    return {
      title: 'Bonjour / mDNS 广播异常',
      summary: '检测到 Bonjour/mDNS 在 probing 阶段异常,可能导致 Gateway 崩溃循环。',
      suggestion: '建议在 openclaw.json 顶层加入 discovery.mdns.mode = off,然后重启 Gateway。',
    };
  }
  if (/EADDRINUSE|already in use|port .* is already in use/i.test(merged)) {
    return {
      title: '端口占用冲突',
      summary: '检测到 Gateway 端口已被占用,可能有残留进程或重复启动。',
      suggestion: '建议先停止 Gateway,确认端口占用进程后再启动。',
    };
  }
  if (/Gateway not reachable|ECONNREFUSED|runtime:\s*stopped|Service is loaded but not running|Main process exited/i.test(merged)) {
    return {
      title: 'Gateway 未正常运行',
      summary: '检测到 Gateway 未真正监听或启动后立即退出。',
      suggestion: '建议先查看最近日志,再执行 openclaw doctor 排查。',
    };
  }
  if (/timeout|ECONNRESET|closed before connect/i.test(merged)) {
    return {
      title: '探针或连接异常',
      summary: 'Gateway 可能已启动,但探针握手或本地连接仍不稳定。',
      suggestion: '建议稍等后重试状态检查,并结合日志确认是否仍有插件或握手异常。',
    };
  }
  if (/Runtime:\s*running|Listening:/i.test(statusText)) {
    return {
      title: 'Gateway 基本正常',
      summary: 'Gateway 进程在运行,且至少已有监听迹象。',
      suggestion: '如功能正常,可继续使用;如仍有个别异常,再看日志细节。',
    };
  }
  return {
    title: '未识别的状态',
    summary: '暂未匹配到明确故障特征。',
    suggestion: '建议查看完整 gateway status、最近日志,必要时执行 openclaw doctor。',
  };
}

async function diagnoseGatewayQuick(ask) {
  renderScreenTitle('一键检查 Gateway 故障原因', '正在采集 Gateway 状态与最近日志，请稍等...');
  const inspected = inspectGatewayStatus({ force: true });
  const logs = inspectGatewayLogs(80);
  const result = diagnoseGateway(inspected.output, logs);
  printInfoLines([
    `${color('诊断结果:', C.gray)} ${color(result.title, C.yellow, C.bold)}`,
    `${color('结论:', C.gray)} ${color(result.summary, C.white)}`,
    `${color('建议:', C.gray)} ${color(result.suggestion, C.white)}`,
  ]);
  if (result.title === 'Bonjour / mDNS 广播异常') {
    console.log(color('建议修复步骤：', C.bold));
    console.log('1. 先备份配置:');
    console.log(`   ${color(`cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%F-%H%M%S)`, C.white)}`);
    console.log('2. 在 openclaw.json 顶层加入:');
    console.log(color('   "discovery": { "mdns": { "mode": "off" } }', C.white));
    console.log('3. 重启 Gateway:');
    console.log(`   ${color('openclaw gateway restart', C.white)}`);
    console.log('');
  } else if (result.title === '端口占用冲突') {
    console.log(color('建议修复步骤：', C.bold));
    console.log(`1. ${color('openclaw gateway stop', C.white)}`);
    console.log(`2. ${color('openclaw gateway status', C.white)}`);
    console.log(color('3. 如仍占用端口,再检查占用进程后重新启动。', C.gray));
    console.log('');
  } else if (result.title === 'Gateway 正在重启 / 重载中') {
    console.log(color('建议处理步骤：', C.bold));
    console.log(color('1. 先稍等 20~60 秒,让 Gateway 或 Telegram 通道完成重启/重载。', C.gray));
    console.log(`2. ${color('openclaw gateway status', C.white)}`);
    console.log(color('3. 如长时间未恢复,再查看日志或执行 openclaw doctor。', C.gray));
    console.log('');
  } else if (result.title === 'Gateway 未正常运行') {
    console.log(color('建议修复步骤：', C.bold));
    console.log(`1. ${color('openclaw doctor', C.white)}`);
    console.log(`2. ${color('journalctl --user -u openclaw-gateway.service -n 80 --no-pager', C.white)}`);
    console.log(`3. ${color('openclaw gateway restart', C.white)}`);
    console.log('');
  }
  const logLines = logs.trim().split('\n');
  const tail = logLines.slice(-12).join('\n');
  await finishScreen(ask, [
    `${color('最近状态摘要:', C.gray)} ${color(inspected.summary, C.white)}`,
    `${color('最近日志关键片段:', C.gray)}`,
    color(tail || '(未获取到日志输出)', C.white),
  ]);
}


async function installOpenClaw(ask) {
  renderScreenTitle('安装 OpenClaw');
  const currentVersionFull = getOpenClawVersion();
  const currentVersion = extractOpenClawVersion(currentVersionFull);
  if (!currentVersion || currentVersion === '未知版本') {
    warn('未能识别当前已安装版本,暂时无法执行同版本重装。');
    await backPrompt(ask);
    return;
  }
  printInfoLines([
    `${color('当前版本：', C.gray)} ${color(currentVersionFull, C.white, C.bold)}`,
    `${color('说明:', C.gray)} ${color(`将执行 npm install -g openclaw@${currentVersion} 进行同版本重装。`, C.white)}`,
  ]);
  const confirm = await ask(color('确认安装 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info(`正在重装 OpenClaw ${currentVersion}，请稍等...`);
  const res = runCommand('npm', ['install', '-g', `openclaw@${currentVersion}`], { stdio: 'inherit' });
  if (res.status === 0) {
    await finishScreen(ask, [color(`OpenClaw 重装完成。当前版本：${getOpenClawVersion()}`, C.green, C.bold)]);
  } else {
    await finishScreen(ask, [color('OpenClaw 重装失败,请检查 npm、网络或权限。', C.red, C.bold)]);
  }
}

async function startOpenClaw(ask) {
  renderScreenTitle('启动 OpenClaw');
  const confirm = await ask(color('确认启动 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info('正在启动 OpenClaw，请稍等...');
  const res = runCommand('openclaw', ['gateway', 'start'], { stdio: 'inherit' });
  if (res.status === 0) {
    await finishScreen(ask, [color('OpenClaw 启动命令已执行完成。', C.green, C.bold)]);
  } else {
    await finishScreen(ask, [color('OpenClaw 启动失败,请检查环境或手动排查。', C.red, C.bold)]);
  }
}

async function stopOpenClaw(ask) {
  renderScreenTitle('停止 OpenClaw');
  const confirm = await ask(color('确认停止 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info('正在停止 OpenClaw，请稍等...');
  const res = runCommand('openclaw', ['gateway', 'stop'], { stdio: 'inherit' });
  if (res.status === 0) {
    await finishScreen(ask, [color('OpenClaw 已执行停止命令。', C.green, C.bold)]);
  } else {
    await finishScreen(ask, [color('OpenClaw 停止失败,请检查环境或手动排查。', C.red, C.bold)]);
  }
}

async function upgradeOpenClaw(ask) {
  renderScreenTitle('升级 OpenClaw', '正在检测版本信息，请稍等...');
  const currentVersionFull = getOpenClawVersion();
  const currentVersion = extractOpenClawVersion(currentVersionFull, currentVersionFull);
  const latestVersion = getLatestOpenClawVersion();

  console.log('');
  if (currentVersion === latestVersion && currentVersion !== '未知') {
    console.log(`当前版本：${color(currentVersionFull, C.green, C.bold)}`);
    console.log(`最新版本: ${color(`OpenClaw ${latestVersion} (npm正式版)`, C.green, C.bold)}`);
  } else {
    console.log(`当前版本：${color(currentVersionFull, C.yellow, C.bold)}`);
    console.log(`最新版本: ${color(`OpenClaw ${latestVersion} (npm正式版)`, C.green, C.bold)}`);
  }
  console.log('');

  if (currentVersion === latestVersion && currentVersion !== '未知') {
    success('当前已是最新版本,无需升级。');
    await backPrompt(ask);
    return;
  }
  if (latestVersion === '未知') {
    warn('暂时无法检测 npm 最新版本,可能是网络问题;仍可尝试用 OpenClaw 官方更新流程。');
  } else {
    info(`检测到新版本 ${latestVersion}。`);
  }

  const confirm = await ask(color('确认升级 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  try {
    backupConfig('pre-update');
    info('已自动备份当前配置。');
  } catch (err) {
    warn(`升级前自动备份失败:${err.message}`);
  }
  info('正在执行官方更新流程:openclaw update');
  const res = runCommand('openclaw', ['update'], { stdio: 'inherit' });
  const combinedUpdateOutput = `${res.stdout || ''}${res.stderr || ''}`;
  const newVersion = getOpenClawVersion();
  if (res.status === 0) {
    const lines = [];
    if (newVersion !== currentVersionFull) {
      lines.push(color(`OpenClaw 升级成功。当前版本：${newVersion}`, C.green, C.bold));
    } else {
      lines.push(color(`更新流程已完成,但当前版本仍为:${newVersion}`, C.yellow, C.bold));
      lines.push(color('这通常表示当前安装源暂无更新,或更新未切换到新的可执行版本。', C.white));
    }
    if (/Completion cache update failed|ETIMEDOUT/i.test(combinedUpdateOutput)) {
      lines.push(color('检测到 completion cache 更新超时;这通常不影响本次升级结果,只会影响部分命令补全缓存刷新。', C.white));
    }
    await finishScreen(ask, lines);
  } else {
    await finishScreen(ask, [color('OpenClaw 更新命令执行失败,请检查网络、安装源或 update 输出日志。', C.red, C.bold)]);
  }
}

async function restartGateway(ask) {
  renderScreenTitle('重启 Gateway', '正在重启 Gateway，请稍等...');
  const res = runCommand('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
  if (res.status === 0) {
    await finishScreen(ask, [color('Gateway 重启命令已执行完成。', C.green, C.bold)]);
  } else {
    await finishScreen(ask, [color('Gateway 重启失败,请检查环境或手动执行命令排查。', C.red, C.bold)]);
  }
}

async function installSpecificOpenClawVersion(ask) {
  renderScreenTitle('安装 / 回退指定 OpenClaw 版本');
  const currentVersionFull = getOpenClawVersion();
  const currentVersion = extractOpenClawVersion(currentVersionFull, currentVersionFull);
  console.log(`当前版本：${color(currentVersionFull, C.yellow, C.bold)}`);
  console.log('');
  warn('该功能适用于安装指定版本,或在新版本回归时临时回退。');
  info('将执行 npm install -g openclaw@<version>,随后自动重启 Gateway。');

  const choices = getOpenClawVersionChoices(currentVersionFull);
  console.log('');
  console.log(color('请选择目标版本:', C.bold));
  choices.forEach((item, idx) => {
    const extra = item.label
      ? item.label.includes('当前版本')
        ? color(`  ${item.label}`, C.yellow, C.bold)
        : item.label.includes('最新版本')
          ? color(`  ${item.label}`, C.green, C.bold)
          : color(`  ${item.label}`, C.gray)
      : '';
    console.log(`${color(`[${idx + 1}]`, C.green, C.bold)} ${item.version}${extra}`);
  });
  console.log(`${color(`[${choices.length + 1}]`, C.green, C.bold)} 自定义输入版本号`);
  console.log(`${color('[0]', C.red, C.bold)} 取消`);

  const pick = (await ask(color('请选择版本编号: ', C.yellow, C.bold))).trim();
  if (!pick || pick === '0') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }

  let targetVersion = '';
  const pickNum = Number(pick);
  if (Number.isInteger(pickNum) && pickNum >= 1 && pickNum <= choices.length) {
    targetVersion = choices[pickNum - 1].version;
  } else if (Number.isInteger(pickNum) && pickNum === choices.length + 1) {
    targetVersion = (await ask(color('请输入目标版本号（例如 2026.4.23）：', C.yellow, C.bold))).trim();
  } else {
    danger('无效选择。');
    await backPrompt(ask);
    return;
  }

  if (!targetVersion) {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  if (!/^\d{4}\.\d+\.\d+$/.test(targetVersion)) {
    danger('版本号格式不正确。示例:2026.4.23');
    await backPrompt(ask);
    return;
  }
  console.log('');
  if (targetVersion === currentVersion) {
    warn(`你选择的 ${targetVersion} 与当前版本一致。`);
  } else {
    warn(`将安装指定版本: openclaw@${targetVersion}`);
  }
  const confirm = await ask(color('确认安装 / 回退到指定 OpenClaw 版本？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  try {
    backupConfig('pre-version-install');
    info('已自动备份当前配置。');
  } catch (err) {
    warn(`安装/回退前自动备份失败:${err.message}`);
  }
  info(`正在安装 openclaw@${targetVersion}，请稍等...`);
  const installRes = runCommand('npm', ['install', '-g', `openclaw@${targetVersion}`], { stdio: 'inherit' });
  const newVersion = getOpenClawVersion();
  if (installRes.status !== 0) {
    await finishScreen(ask, [color('指定版本安装失败,请检查 npm、网络或版本号是否存在。', C.red, C.bold)]);
    return;
  }
  const lines = [];
  if (!String(newVersion).includes(targetVersion)) {
    lines.push(color(`安装流程已完成,但当前检测版本为:${newVersion}`, C.yellow, C.bold));
    lines.push(color('可能是当前命令路径未切换,或该版本未真正安装到当前正在使用的环境。', C.white));
  } else {
    lines.push(color(`指定版本安装完成。当前版本：${newVersion}`, C.green, C.bold));
  }
  info('正在重启 Gateway 并验证状态...');
  const restartRes = runCommand('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
  if (restartRes.status === 0) {
    lines.push(color('Gateway 重启命令已执行完成。', C.green, C.bold));
  } else {
    lines.push(color('Gateway 重启失败,请手动检查服务状态。', C.red, C.bold));
  }
  await finishScreen(ask, lines);
}

async function backupOpenClaw(ask) {
  section('备份 OpenClaw 配置');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(os.homedir(), `openclaw-backup-${ts}.tar.gz`);
  info('正在备份 ~/.openclaw，请稍等...');
  const res = spawnSync('tar', ['-czf', output, '-C', os.homedir(), '.openclaw'], { stdio: 'inherit' });
  if (res.status === 0) {
    success('OpenClaw 配置备份成功。');
    info(`备份文件:${output}`);
  } else {
    danger('OpenClaw 配置备份失败,请检查磁盘空间或权限。');
  }
  await backPrompt(ask);
}

async function uninstallOpenClaw(ask) {
  section('卸载 OpenClaw');
  warn('将卸载 OpenClaw 程序本体,但保留 ~/.openclaw 配置和数据。');
  const confirm = await ask(color('确认卸载 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info('正在卸载 OpenClaw，请稍等...');
  const res = runCommand('npm', ['uninstall', '-g', 'openclaw'], { stdio: 'inherit' });
  if (res.status === 0) {
    success('OpenClaw 卸载成功。');
    info('本地配置和数据已保留。');
  } else {
    danger('OpenClaw 卸载失败,请检查 npm 或权限配置。');
  }
  await backPrompt(ask);
}

async function purgeOpenClaw(ask) {
  section('彻底卸载 OpenClaw');
  danger('危险操作:将卸载 OpenClaw,并删除 ~/.openclaw 全部配置和数据。');
  warn('建议先执行 [16] 备份 OpenClaw 配置。');
  const confirm = await ask(color('高危确认：彻底卸载 OpenClaw？(y/N): ', C.red, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info('正在卸载 OpenClaw，请稍等...');
  const uninstallRes = runCommand('npm', ['uninstall', '-g', 'openclaw'], { stdio: 'inherit' });
  try {
    fs.rmSync(path.join(os.homedir(), '.openclaw'), { recursive: true, force: true });
  } catch (err) {
    danger(`数据目录删除失败: ${err.message}`);
    await backPrompt(ask);
    return;
  }
  if (uninstallRes.status === 0) {
    success('OpenClaw 已彻底卸载。');
    info('程序、本地配置和数据均已删除。');
  } else {
    warn('程序卸载可能未完成,但 ~/.openclaw 已删除。');
  }
  await backPrompt(ask);
}

async function repairHelperScripts(ask) {
  renderScreenTitle('检查 / 修复脚本依赖');
  const targetFiles = ['add-provider.mjs', 'provider-manage.mjs', 'list-providers-cn.mjs'];
  const beforeMissing = targetFiles.filter((name) => !fs.existsSync(path.join(__dirname, name)));
  const created = ensureHelperScripts({ verbose: false });
  ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
  ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json', verbose: true });
  const prunedDisplayNames = pruneDisplayNameMap({ verbose: false });
  const checkedCount = targetFiles.length + 2;
  const lines = created.length
    ? [
        color(`已补齐缺失辅助脚本:${created.join('、')}`, C.green, C.bold),
        color(`检查摘要:共检查 ${checkedCount} 项,补齐 ${beforeMissing.length} 个脚本,JSON 辅助文件已确认可用。`, C.white),
      ]
    : [color('辅助脚本完整,无需补齐。', C.white), color(`检查摘要:共检查 ${checkedCount} 项,脚本与 JSON 辅助文件均可用。`, C.white)];
  if (prunedDisplayNames > 0) lines.push(color(`已清理 ${prunedDisplayNames} 个失效的 provider 显示名映射。`, C.white));
  await finishScreen(ask, lines);
}

async function quickHealthcheck(ask) {
  renderScreenTitle('快速体检');
  const gateway = inspectGatewayStatus({ force: true });
  const state = loadWorkspaceState();
  const requiredScripts = ['add-provider.mjs', 'provider-manage.mjs', 'list-providers-cn.mjs'];
  const missingScripts = requiredScripts.filter((name) => !fs.existsSync(path.join(__dirname, name)));
  const currentVersion = getOpenClawVersion();
  const latestVersion = getLatestOpenClawVersion();
  const serviceWarnings = [];
  const statusText = String(gateway.output || '');
  if (/PATH includes version managers|uses Node from a version manager/i.test(statusText)) {
    serviceWarnings.push('Gateway service 仍在使用版本管理器路径,升级后偶尔可能变慢。');
  }

  const lines = [
    `${color('OpenClaw:', C.gray)} ${color(currentVersion, C.white, C.bold)}`,
    `${color('Gateway:', C.gray)} ${gateway.ok ? color('正常', C.green, C.bold) : color('需关注', C.yellow, C.bold)} ${color(`· ${gateway.summary}`, C.gray)}`,
    `${color('主配置:', C.gray)} ${state.ok ? color('已检测到', C.green, C.bold) : color('未就绪', C.yellow, C.bold)}`,
    `${color('辅助脚本:', C.gray)} ${missingScripts.length ? color(`缺少 ${missingScripts.length} 个`, C.yellow, C.bold) : color('完整', C.green, C.bold)}`,
  ];
  if (latestVersion !== '未知') {
    const currentStable = currentVersion.match(/\d{4}\.\d+\.\d+/)?.[0] || currentVersion;
    lines.push(`${color('版本更新:', C.gray)} ${latestVersion === currentStable ? color('当前已接近最新', C.green, C.bold) : color(`可更新到 ${latestVersion}`, C.yellow, C.bold)}`);
  }
  if (serviceWarnings.length) {
    lines.push(`${color('服务提示:', C.gray)} ${color(serviceWarnings[0], C.yellow)}`);
  }
  if (!state.ok) lines.push(color('建议先运行一次 OpenClaw,确保 ~/.openclaw/openclaw.json 已生成。', C.yellow));
  if (missingScripts.length) lines.push(color(`建议执行 [21] 检查 / 修复脚本依赖(当前缺少:${missingScripts.join('、')})。`, C.yellow));
  if (!gateway.ok) lines.push(color('建议执行 [15] 一键检查 Gateway 故障原因。', C.yellow));
  await finishScreen(ask, lines);
}

async function showScriptVersionDetail(ask) {
  const current = getCurrentMenuVersionInfo();
  const displayVersion = getCurrentMenuDisplayVersion();
  const visibleHistory = MENU_VERSION_HISTORY.slice(0, VERSION_HISTORY_VISIBLE_COUNT);
  renderScreenTitle(`版本:${displayVersion}`);
  const lines = [];
  for (const item of visibleHistory) {
    lines.push(color(`【${item.version}】`, item.version === current.version ? C.white : C.magenta, C.bold));
    for (const line of item.summary) lines.push(color(`  - ${line}`, C.gray));
  }
  await finishScreen(ask, lines);
}

async function installSkill(ask) {
  renderScreenTitle('安装技能');
  const skillsDir = getWorkspaceSkillsDir();
  fs.mkdirSync(skillsDir, { recursive: true });
  const sourceInput = await ask(color('请输入技能目录路径: ', C.bold));
  if (!sourceInput) {
    info('未输入路径,已取消。');
    await backPrompt(ask);
    return;
  }
  const sourcePath = path.resolve(sourceInput);
  const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
  if (!stat || !stat.isDirectory()) {
    danger(`技能目录不存在:${sourcePath}`);
    await backPrompt(ask);
    return;
  }
  const skillFile = path.join(sourcePath, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    danger('目标目录缺少 SKILL.md,不能按技能安装。');
    await backPrompt(ask);
    return;
  }
  const skillName = path.basename(sourcePath);
  const targetPath = path.join(skillsDir, skillName);
  let previewDescription = '未读取到说明';
  try {
    const content = fs.readFileSync(skillFile, 'utf8');
    const match = content.match(/^description:\s*(.+)$/m);
    previewDescription = normalizeSkillDescription(skillName, match?.[1] || '');
  } catch {}
  if (fs.existsSync(targetPath)) {
    danger(`已存在同名技能:${skillName}`);
    info(`目标路径:${targetPath}`);
    await backPrompt(ask);
    return;
  }
  console.log('');
  info(`技能:${skillName}`);
  info(`用途:${previewDescription}`);
  info(`来源:${sourcePath}`);
  const confirm = await ask(color('确认安装该技能？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  copyDirRecursive(sourcePath, targetPath);
  success(`技能安装成功:${skillName}`);
  info(`安装路径:${targetPath}`);
  await backPrompt(ask);
}

async function removeSkill(ask) {
  while (true) {
    const skills = listInstalledSkills();
    renderScreenTitle('删除技能');
    if (!skills.length) {
      warn('当前没有检测到已安装技能。');
      await backPrompt(ask);
      return;
    }
    const rows = skills.map((item, i) => renderNumberedLine(i + 1, item.name, item.description));
    printListScreen('删除技能', rows, { zeroLabel: '返回上一级' });
    const answer = await ask(color('请输入你的选择: ', C.bold));
    if (answer === '0') return;
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx < 1 || idx > skills.length) {
      warn('编号无效,请重新输入。');
      continue;
    }
    const selected = skills[idx - 1];
    console.log('');
    info(`即将删除技能:${selected.name}`);
    const confirm = await ask(color('高危确认：删除该技能目录？(y/N): ', C.yellow, C.bold));
    if (confirm.toLowerCase() !== 'y') {
      info('操作已取消。');
      continue;
    }
    fs.rmSync(selected.path, { recursive: true, force: true });
    success(`已删除技能:${selected.name}`);
    await backPrompt(ask);
    return;
  }
}

async function manageSkills(ask) {
  while (true) {
    const skills = listInstalledSkills();
    const listRows = [
      renderNumberedLine(1, '安装技能', '本地安装'),
      renderNumberedLine(2, '删除技能', skills.length ? `已装 ${skills.length} 个` : '当前没有已装技能'),
    ];
    printListScreen('技能管理', listRows, { zeroLabel: '返回主菜单' });
    const answer = await ask(color('请输入你的选择: ', C.bold));
    if (answer === '0') return;
    if (answer === '1') {
      await installSkill(ask);
      continue;
    }
    if (answer === '2') {
      await removeSkill(ask);
      continue;
    }
    warn('编号无效,请重新输入。');
  }
}

async function printMainMenu() {
  const currentMenuInfo = getCurrentMenuVersionInfo();
  const currentMenuVersion = getCurrentMenuDisplayVersion();
  const currentModel = getCurrentDefaultModel();
  const currentVersionFull = getOpenClawVersion();
  const latestVersion = getLatestOpenClawVersion();
  const gateway = inspectGatewayStatus();
  const currentVersion = extractOpenClawVersion(currentVersionFull, currentVersionFull);
  const gatewayTone = gateway.ok ? C.green : C.yellow;
  const gatewayLabel = gateway.ok ? '正常运行' : '需要关注';
  const versionHint = `${color('当前版本', C.gray)}  ${color(currentVersionFull, C.yellow, C.bold)}`;
  const modelLine = `${color('当前模型', C.gray)}  ${color(currentModel, C.white, C.bold)}`;
  const gatewayLine = `${color('Gateway', C.gray)}  ${color(gatewayLabel, gatewayTone, C.bold)}  ·  ${gateway.summary}`;

  let nextStep = `${color('建议下一步', C.gray)}  ${color('当前状态正常', C.green)}`;
  if (!gateway.ok) {
    nextStep = `${color('建议下一步', C.gray)}  ${color('执行 19. 诊断', C.yellow, C.bold)}`;
  } else if (latestVersion !== '未知' && latestVersion !== currentVersion) {
    nextStep = `${color('建议下一步', C.gray)}  ${color('执行 13. 升级', C.yellow, C.bold)}`;
  }

  const menuItem = (num, label, note = '') => {
    const prefix = `${`${num}.`.padEnd(4, ' ')}`;
    const text = `${color(prefix, C.white, C.bold)}${label}`;
    if (!note) return text;
    const noteTone = note.includes('推荐') || note.includes('可更新到')
      ? color(note, C.yellow, C.bold)
      : color(note, C.gray);
    return `${text}  ${noteTone}`;
  };

  console.log(box('OpenClaw API 管理面板', [
    gatewayLine,
    versionHint,
    modelLine,
    nextStep,
  ], C.white));
  console.log(color('=======================================', C.gray));
  console.log(menuItem(1, '换模型'));
  console.log(menuItem(2, '添加 API'));
  console.log(menuItem(3, '删除 API'));
  console.log(menuItem(4, '同步 API'));
  console.log(menuItem(5, '修改 API'));
  console.log(menuItem(6, '查看 API'));
  console.log(menuItem(7, '搜索模型'));
  console.log(menuItem(8, '常用模型'));
  console.log(color('--------------------', C.gray));
  console.log(menuItem(9, '技能管理'));
  console.log(color('--------------------', C.gray));
  console.log(menuItem(10, '安装 OpenClaw'));
  console.log(menuItem(11, '启动 OpenClaw'));
  console.log(menuItem(12, '停止 OpenClaw'));
  console.log(menuItem(13, '升级 OpenClaw', latestVersion !== '未知' && latestVersion !== currentVersion ? `可更新到 ${latestVersion}` : ''));
  console.log(menuItem(14, '回退指定 OpenClaw 版本'));
  console.log(menuItem(15, '重启 Gateway'));
  console.log(menuItem(16, '备份 OpenClaw 配置'));
  console.log(menuItem(17, '卸载 OpenClaw'));
  console.log(menuItem(18, '彻底卸载 OpenClaw'));
  console.log(menuItem(19, '一键检查 Gateway 故障原因'));
  console.log(color('--------------------', C.gray));
  console.log(menuItem(20, `版本: ${currentMenuVersion}`));
  console.log(menuItem(21, '检查/修复脚本依赖'));
  console.log(menuItem(22, '快速体检'));
  console.log(color('--------------------', C.gray));
  console.log(renderNumberedLine(0, '退出'));
  console.log(color('--------------------', C.gray));
}

async function showMenu() {
  const isHelp = process.argv.includes('--help') || process.argv.includes('-h');
  if (isHelp) {
    console.log(box('OpenClaw API 管理工具', [
      color(`版本: ${getCurrentMenuDisplayVersion()} | 更新: ${getCurrentMenuVersionInfo().updatedAt}`, C.dim),
      color('功能: 模型切换 / API 增删改 / 模型同步 / 系统升级重启 / 备份卸载', C.dim),
    ], C.cyan));
    console.log('');
    console.log(color(' 版本历史', C.bold));
    for (const item of MENU_VERSION_HISTORY) {
      console.log(`  ${color(item.version, C.cyan, C.bold)}  ${color(item.updatedAt, C.gray)}  ${item.summary.join(';')}`);
    }
    console.log('\n');
    console.log(color(' 📖 使用说明', C.bold));
    console.log('  🔹 直接运行:ocapi');
    console.log('  🔹 查看帮助:ocapi --help\n');
    console.log(color(' ⌨️  操作说明', C.bold));
    console.log('  🔹 输入对应数字 + 回车,选择功能');
    console.log('  🔹 直接回车 / 输入 0. 返回上一级或退出');
    console.log('  🔹 危险操作需要输入 Y 确认');
    console.log('  🔹 延迟颜色:<200ms 绿 / 200-500ms 黄 / >500ms 洋红 / 不可用红');
    console.log('  🔹 不可用 API 会用红点闪烁提示');
    console.log('\n');
    process.exit(0);
  }

  ensureHelperScripts({ verbose: true });
  ensureOcapiShortcut({ verbose: true });
  pruneDisplayNameMap({ verbose: false });
  remindMenuVersionBackup();
  const startup = loadWorkspaceState({ verbose: true });
  if (!startup.ok) {
    console.log(box('首次使用提示', [
      startup.reason,
      startup.hint,
      '脚本目录里的 JSON 辅助文件已自动准备好。',
      '运行入口:ocapi',
      `备用运行方式:node ${path.join(__dirname, 'openclaw-api-menu.mjs')}`,
      '首次建议顺序:先运行一次 OpenClaw → 再运行 ocapi → 如命令不可用再用 node 方式启动。',
      '如果是新机器迁移,建议再执行一次 [21] 检查 / 修复脚本依赖。',
    ], C.yellow));
  }

  const ask = askFactory();
  try {
    while (true) {
      await printMainMenu();
      const choice = (await ask(color('\n请输入你的选择: ', C.bold))).toLowerCase();
      // 直接回车默认当作0退出/返回
      const finalChoice = choice.trim() || '0';
      if (finalChoice === '0') {
        success('已退出。');
        break;
      }
      if (finalChoice === '1') await switchDefaultModel(ask);
      else if (finalChoice === '2') await addProvider(ask);
      else if (finalChoice === '3') await removeProvider(ask);
      else if (finalChoice === '4') await syncProvider(ask);
      else if (finalChoice === '5') await modifyProvider(ask);
      else if (finalChoice === '6') await showProvidersDetail(ask);
      else if (finalChoice === '7') await searchModelsGlobally(ask);
      else if (finalChoice === '8') await quickSwitchFavorite(ask);
      else if (finalChoice === '9') await manageSkills(ask);
      else if (finalChoice === '10') await installOpenClaw(ask);
      else if (finalChoice === '11') await startOpenClaw(ask);
      else if (finalChoice === '12') await stopOpenClaw(ask);
      else if (finalChoice === '13') await upgradeOpenClaw(ask);
      else if (finalChoice === '14') await installSpecificOpenClawVersion(ask);
      else if (finalChoice === '15') await restartGateway(ask);
      else if (finalChoice === '16') await backupOpenClaw(ask);
      else if (finalChoice === '17') await uninstallOpenClaw(ask);
      else if (finalChoice === '18') await purgeOpenClaw(ask);
      else if (finalChoice === '19') await diagnoseGatewayQuick(ask);
      else if (finalChoice === '20') await showScriptVersionDetail(ask);
      else if (finalChoice === '21') await repairHelperScripts(ask);
      else if (finalChoice === '22') await quickHealthcheck(ask);
      else warn('无效选择,请重新输入。');
    }
  } finally {
    ask.close();
  }
}

showMenu().catch((err) => {
  console.error('\n脚本执行失败:');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
