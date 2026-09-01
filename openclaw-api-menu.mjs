#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE = path.resolve(__dirname, '..');
// 统一状态目录:全部脚本共用同一套 OPENCLAW_STATE_DIR,避免主菜单与子脚本读写不同配置。
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
const CONFIG = path.join(STATE_DIR, 'openclaw.json');
const DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');
const RECENT_MODELS = path.join(__dirname, 'recent-models.json');
const LOCAL_MENU_CONFIG = path.join(STATE_DIR, 'openclaw-api-menu.local.json');
const TELEGRAM_BOT_NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_BOT_NAME_FETCH_TIMEOUT_MS = 8000;
const telegramBotNameCache = { value: '', tokenHash: '', ts: 0 };
const telegramChatNameCache = new Map();
const STATUS_CACHE_TTL_MS = 30 * 1000; // Provider状态缓存30秒,平衡检测频率和用户体验
const PINNED_DIRECT_SESSION_IDS = new Set([]);
const MODEL_STATUS_TIMEOUT_MS = 5000;
const PROVIDER_SYNC_FETCH_TIMEOUT_MS = 8000;
const PROVIDER_STATUS_TIMEOUT_MS = 8000;
const MODEL_STATUS_RETRY_TIMEOUT_MS = 12000;
const MODEL_STATUS_TEST_PROMPT = '用一句话说明 HTTPS 比 HTTP 多了什么。';
const MODEL_STATUS_DEFAULT_PROMPT = '用一句话说明 HTTPS 比 HTTP 多了什么。';
const MODEL_STATUS_USER_AGENT = 'Mozilla/5.0 BatchApiCheck/1.0';
const MODEL_STATUS_FALLBACK_ENDPOINTS = ['chat/completions', 'responses'];
const MODEL_STATUS_CACHE_SCHEMA = 'v7';
const LATEST_VERSION_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const GATEWAY_MENU_CACHE_TTL_MS = 2 * 60 * 1000;
const GATEWAY_RESTART_CHECK_INTERVAL_MS = 10 * 1000;
const GATEWAY_RESTART_CHECK_MAX_ATTEMPTS = 20;
const VERSION_HISTORY_VISIBLE_COUNT = 20;
const modelStatusCache = new Map();
// 维护规矩:
// 0. 发布规则:每次修改本脚本后必须: bump版本号 → commit 4个脚本 → push main → push tag(同名版本号)。
//    GitHub Repo: github.com/Ghouls-2020/openclaw-api-menu
//    脚本文件(4个,放repo根目录):openclaw-api-menu.mjs / add-provider.mjs / provider-manage.mjs / list-providers-cn.mjs
//    版本号从 MENU_VERSION_HISTORY[0].version 读取;patch递增;GitHub Actions 自动从 tag 生成 Release
//    SSH Deploy Key:若VPS重装,需重新配置 ~/.ssh/config 中的 github-openclaw-api-menu 别名。
// 1. 每次修改完成后,必须在 MENU_VERSION_HISTORY 顶部新增当前版本记录,当前版本号/更新时间会自动从该记录读取
// 2. 修改涉及界面输出时,先检查实际显示效果,避免重复分隔线、重复选项或错位
// 3. 非 TTY / Telegram 环境优先稳定显示,避免 console.clear() / 渐进刷新 / 重复刷屏
// 4. 新增交互功能时,优先保持与现有"操作完成 / 按任意键继续..."风格一致
// 5. MENU_VERSION_HISTORY 只保留最近 20 条;主菜单 [20] 版本记录页也只显示最近 20 条
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
const MENU_VERSION_HISTORY = [
  {
    version: 'v0.0.104',
    updatedAt: '2026-09-01',
    summary: [
      '适配 OpenClaw 2026.8.1 模型白名单:新增、删除、同步和 Provider ID 迁移会维护 modelPolicy.allow。',
      '补齐 utilityModel、mediaModels 与多 Agent 模型引用在 Provider ID 迁移/删除时的处理。',
      '模型菜单按生效白名单过滤,并兼容 Provider 通配符、精确模型和别名。',
      '适配 2026.8.1 SQLite 会话目录,优先通过官方 sessions CLI 读取 Telegram 会话。',
      '清理 Telegram 会话改用官方 sessions delete,不再直接写入 SQLite 或误报会话文件不存在。',
      '通过 Telegram getChat 恢复群名,并在私聊列表显示所属 Agent。',
      '适配 2026.8.x agents.entries 对象,保留旧版 agents.list 回退。',
    ],
  },
  {
    version: 'v0.0.99',
    updatedAt: '2026-08-31',
    summary: [
      '修复多 agent Telegram 会话识别:按各 agent 的 sessions.json 扫描,支持 weather 等非 main agent 群聊。',
      '会话菜单显示 agent 名称,避免 main 中的旧同名记录与 weather 实际会话混淆。',
      'Telegram 会话模型切换优先通过 Gateway sessions.patch 写入,避免直接改 sessions.json 被 Gateway 缓存覆盖。',
    ],
  },
  {
    version: 'v0.0.95',
    updatedAt: '2026-08-13',
    summary: [
      '修复 setDowngradeConfigTouchedVersion 下方残留的旧孤立代码块，导致 node --check 报 Illegal return statement。',
      '确认 4 项修复已全部到位，无需额外改动：',
      '必修1: STATE_DIR 统一 (4 脚本均用 process.env.OPENCLAW_STATE_DIR || ~/.openclaw)',
      '必修2: 降级时不破坏 openclaw.json (优先 CLI patch, 回退定向文本替换 + 保留权限)',
      '必修3: add-provider 幂等检测 (provider 已存在时视为写入成功)',
      '必修4: 卸载失败保护 (npm uninstall 失败或程序仍存在时询问用户再删配置)',
    ],
  },
  {
    version: 'v0.0.94',
    updatedAt: '2026-08-13',
    summary: [
      '确认 4 项修复已全部到位，无需额外改动。',
    ],
  },
  {
    version: 'v0.0.93',
    updatedAt: '2026-08-07',
    summary: [
      '修复 sessions.json 全量覆盖竞态条件：写入前重新读取并最小合并，避免覆盖 Gateway 并发写入。',
    ],
  },
  {
    version: 'v0.0.92',
    updatedAt: '2026-08-07',
    summary: [
      '修复 getOpenClawVersionChoices 中 catch bare return 导致菜单崩溃的问题。',
      '修复 detectModelStatus 失败路径错误将 online 设为 true 导致模型误显在线。',
      '修复 progressBar total=0 时 NaN 崩溃、C.dim 未定义导致帮助失显、backPrompt 死循环。',
    ],
  },
  {
    version: 'v0.0.91',
    updatedAt: '2026-08-07',
    summary: [
      '修复 add-provider.mjs 与 provider-manage.mjs 共 4 处 JSON.parse 缺少 try/catch 保护。',
      'cleanupSystemdUserGatewayService 删除文件失败时增加 warn 提示。',
    ],
  },
  {
    version: 'v0.0.90',
    updatedAt: '2026-08-07',
    summary: [
      '修复 switchDefaultModel 选择模型后死循环无法退出的问题。',
      '修复 5 处 JSON.parse 缺少 try/catch 保护的问题。',
    ],
  },
  {
    version: 'v0.0.89',
    updatedAt: '2026-08-06',
    summary: [
      '移除脚本启动时自动备份主菜单文件的功能。',
      '脚本版本通过 Git 提交与发布 tag 管理，不再在本地重复生成菜单脚本备份。',
    ],
  },
  {
    version: 'v0.0.88',
    updatedAt: '2026-08-05',
    summary: [
      '修复 add-provider / list-providers-cn / provider-manage 共 16 个逻辑 bug。',
      '最严重：provider-manage sync 模型引用 key 拼错导致同步功能实际不工作。',
      '统一 modelsUrl 拼接规则(不再被 query/fragment 污染)、JSON.parse 加顶层保护、displayNames 加类型校验。',
    ],
  },
  {
    version: 'v0.0.87',
    updatedAt: '2026-08-04',
    summary: [
      '取消 add-provider.mjs 与 provider-manage.mjs 对 openclaw.json 的自动备份。',
      '清理主菜单与辅助脚本残留的 --no-backup 兼容参数，统一改为始终直接写配置。',
    ],
  },
  {
    version: 'v0.0.86',
    updatedAt: '2026-08-03',
    summary: [
      '修复 ensureOcapiShortcut 单引号转义写错会破坏用户 ~/.zshrc 的问题。',
      '路径含撇号时不再产生不闭合的引号导致 shell 解析中断。',
    ],
  },
  {
    version: 'v0.0.85',
    updatedAt: '2026-08-02',
    summary: [
      '修复 pruneDisplayNameMap 在配置读取出错时误清空所有中文显示名的问题。',
      'openclaw.json 损坏/不存在时不再清空 provider-display-names.json。',
    ],
  },
  {
    version: 'v0.0.84',
    updatedAt: '2026-08-02',
    summary: [
      '优化 Provider 状态缓存时间从 60 秒降至 30 秒。',
      '用户修复 API Key 后能更快看到最新状态，平衡检测频率和体验。',
    ],
  },
  {
    version: 'v0.0.83',
    updatedAt: '2026-08-02',
    summary: [
      '恢复仓库根目录的 4 个独立脚本，并保留取消 openclaw.json 自动备份的修改。',
      '补充 VPS 重装后的 GitHub SSH 发布规则。',
    ],
  },
  {
    version: 'v0.0.80',
    updatedAt: '2026-08-02',
    summary: [
      '取消菜单修改 openclaw.json 前的自动备份，配置现在直接写入。',
      '添加、删除、修改、同步 API、切换默认模型及升级 OpenClaw 均不再生成 openclaw.json-* 备份。',
    ],
  },
  {
    version: 'v0.0.79',
    updatedAt: '2026-07-25',
    summary: [
      '统一 loadWorkspaceState().cfg 的空配置防护，新增 getWorkspaceCfg()。',
      '换模型/查看状态/常用模型等路径在 openclaw.json 损坏时友好降级，不再直接崩溃。',
    ],
  },
  {
    version: 'v0.0.78',
    updatedAt: '2026-06-21',
    summary: [
      '修复 provider-manage.mjs 在 provider 找不到时误报“Provider id 非法”的问题。',
      '现在 resolveProviderKey 返回 null 时先提示“Provider not found”，再对有效 id 做合法性校验。',
    ],
  },
  {
    version: 'v0.0.77',
    updatedAt: '2026-06-19',
    summary: [
      '修复 openclaw.json 损坏或不存在时 getCurrentDefaultModel 读取 cfg.agents 崩溃的问题。',
      '现在 cfg 为 null 时会友好返回"配置不可用",避免菜单无法启动。',
    ],
  },
  {
    version: 'v0.0.76',
    updatedAt: '2026-06-14',
    summary: [
      '添加、删除、修改、同步 API 写入配置前都增加"正在写入配置，请稍等..."提示。',
      '统一在所有 config patch 调用前显示进度提示,让用户知道脚本仍在工作。',
    ],
  },
  {
    version: 'v0.0.75',
    updatedAt: '2026-06-14',
    summary: [
      '全部同步模型完成后、写入配置前增加"正在写入配置，请稍等..."提示。',
      '避免用户误以为脚本卡死，实际是在调用 openclaw config patch 验证并写入配置。',
    ],
  },
  {
    version: 'v0.0.74',
    updatedAt: '2026-06-14',
    summary: [
      '删除 Provider 时同步支持 fallback 提升逻辑。',
      'primary 被删后如有剩余 fallback,优先提升第一个 fallback 为新 primary,避免默认模型类字段意外清空。',
    ],
  },
  {
    version: 'v0.0.73',
    updatedAt: '2026-06-11',
    summary: [
      '同步模型修复失效 primary 时,优先提升现有仍有效的 fallback。',
      '只有没有可用 fallback 时才使用 /models 返回的第一个模型兜底,避免默认模型意外切到新列表首项。',
    ],
  },
  {
    version: 'v0.0.72',
    updatedAt: '2026-06-10',
    summary: [
      '修复 npm 最新版本检测失败时可能把 stderr 当成版本号显示的问题。',
      '只有 npm view 成功且 stdout 是合法版本号时才显示最新版本,否则返回“未知”。',
    ],
  },
  {
    version: 'v0.0.71',
    updatedAt: '2026-06-09',
    summary: [
      '修复删除 Provider 后默认模型类字段可能残留旧 Provider 引用的问题。',
      '默认选择字段被清空时现在会显式提交 null patch,确保 openclaw.json 真正删除对应字段。',
    ],
  },
  {
    version: 'v0.0.70',
    updatedAt: '2026-06-09',
    summary: [
      '删除 API 时如果该 Provider 正被默认主模型使用,主菜单提前阻止删除。',
      '提示用户先到 [1] 换模型,避免确认删除后才被辅助脚本拒绝。',
    ],
  },
  {
    version: 'v0.0.69',
    updatedAt: '2026-06-08',
    summary: [
      '清理群聊记录不再创建 sessions.json.bak.menu-delete 备份文件。',
      '该操作仍只删除 OpenClaw 本地会话列表记录,不会退出或删除 Telegram 群。',
    ],
  },
  {
    version: 'v0.0.68',
    updatedAt: '2026-06-08',
    summary: [
      '常用模型菜单隐藏 Provider 异常原因,避免和模型不可用原因重复显示。',
      '菜单 8 中 Provider 状态保留“在线但异常 | 延迟”,具体失败原因交给后面的模型检测结果显示。',
    ],
  },
  {
    version: 'v0.0.67',
    updatedAt: '2026-06-08',
    summary: [
      '统一 Provider/API 状态文案为“在线、在线但异常、离线/不可达”。',
      '菜单 1、菜单 8、API 列表等 Provider 状态不再使用“可用但异常”,避免和模型可用性混淆。',
    ],
  },
  {
    version: 'v0.0.66',
    updatedAt: '2026-06-08',
    summary: [
      '调整 Provider 连通状态文案,正常连通时显示“在线”而不是“可用”。',
      '常用模型菜单中 Provider 状态和模型测活结果分开显示,避免“可用 | 可用”混淆。',
    ],
  },
];
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
  const percent = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
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
  const escapeShellSingle = (value) => String(value).replace(/'/g, "'\\''");
  const aliasLine = `alias ocapi='${escapeShellSingle(process.execPath)} ${escapeShellSingle(__filename)}'`;
  const shellName = path.basename(process.env.SHELL || '').toLowerCase();
  const candidates = [];
  if (shellName.includes('zsh')) candidates.push('.zshrc');
  else if (shellName.includes('bash')) candidates.push('.bashrc');
  else candidates.push('.zshrc', '.bashrc');
  for (const fallback of ['.zshrc', '.bashrc']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  try {
    const targetName = candidates[0];
    const targetPath = path.join(os.homedir(), targetName);
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    if (/^\s*alias\s+ocapi=/m.test(current) || current.includes(aliasLine)) {
      return { changed: false, exists: true, path: targetPath };
    }
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(targetPath, `${prefix}\n# OpenClaw API menu shortcut\n${aliasLine}\n`);
    if (verbose) {
      success('已添加快捷命令: ocapi');
      info(`新开终端后可直接输入 ocapi；当前终端可执行: source ~/${targetName}`);
    }
    return { changed: true, path: targetPath, aliasLine };
  } catch (err) {
    if (verbose) warn(`添加 ocapi 快捷命令失败:${err.message}`);
    return { changed: false, error: err.message, path: path.join(os.homedir(), candidates[0] || '.bashrc') };
  }
}

function pruneDisplayNameMap(options = {}) {
  const { verbose = false } = options;
  const cfg = readJson(CONFIG, null);
  if (!cfg || typeof cfg !== 'object') return 0;
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

function splitModelRef(ref) {
  const text = String(ref || '');
  const firstSlash = text.indexOf('/');
  if (firstSlash === -1) return [text, ''];
  return [text.slice(0, firstSlash), text.slice(firstSlash + 1)];
}

function getExplicitModelPolicyAllow(cfg = {}, agentId = '') {
  const agentAllow = agentId ? cfg.agents?.entries?.[agentId]?.modelPolicy?.allow : null;
  const allow = Array.isArray(agentAllow) ? agentAllow : cfg.agents?.defaults?.modelPolicy?.allow;
  return Array.isArray(allow) && allow.length > 0 ? allow : null;
}

function isModelAllowedByPolicy(cfg, ref, agentId = '') {
  const allow = getExplicitModelPolicyAllow(cfg, agentId);
  if (!allow) return true;
  const candidate = String(ref || '');
  const alias = cfg.agents?.defaults?.models?.[candidate]?.alias;
  return allow.some((entry) => {
    const rule = String(entry || '');
    if (rule.endsWith('*')) return candidate.startsWith(rule.slice(0, -1));
    return candidate === rule || (typeof alias === 'string' && alias === rule);
  });
}

function addProviderToModelPolicy(defaults = {}, providerId) {
  const allow = Array.isArray(defaults?.modelPolicy?.allow) && defaults.modelPolicy.allow.length > 0
    ? defaults.modelPolicy.allow
    : null;
  if (!allow) return null;
  const wildcard = `${providerId}/*`;
  return allow.includes(wildcard) ? [...allow] : [...allow, wildcard];
}

function rewriteProviderModelPolicy(defaults = {}, oldName, newName = '') {
  const allow = Array.isArray(defaults?.modelPolicy?.allow) && defaults.modelPolicy.allow.length > 0
    ? defaults.modelPolicy.allow
    : null;
  if (!allow) return null;
  const rewritten = [];
  for (const ref of allow) {
    if (!isProviderRef(ref, oldName)) {
      rewritten.push(ref);
      continue;
    }
    if (newName) rewritten.push(rewriteProviderRef(ref, oldName, newName));
  }
  return [...new Set(rewritten)];
}

function rewriteProviderRefsDeep(value, oldName, newName) {
  if (typeof value === 'string') return rewriteProviderRef(value, oldName, newName);
  if (Array.isArray(value)) return value.map((item) => rewriteProviderRefsDeep(item, oldName, newName));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = isProviderRef(key, oldName) ? rewriteProviderRef(key, oldName, newName) : key;
    result[nextKey] = rewriteProviderRefsDeep(item, oldName, newName);
  }
  return result;
}

function rewriteProviderRefsInAgentEntries(config, oldName, newName) {
  const entries = config.agents?.entries;
  if (!entries || typeof entries !== 'object') return {};
  const changed = {};
  for (const [agentId, entry] of Object.entries(entries)) {
    const next = rewriteProviderRefsDeep(entry, oldName, newName);
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      entries[agentId] = next;
      changed[agentId] = next;
    }
  }
  return changed;
}

function getSessionStorePath(agentId = 'main') {
  const stateDir = STATE_DIR;
  return path.join(stateDir, 'agents', String(agentId || 'main'), 'sessions', 'sessions.json');
}

function getConfiguredAgentIds() {
  const cfg = readJson(CONFIG, {});
  const ids = [];
  // OpenClaw 2026.8.x stores configured agents as an entries object.
  for (const id of Object.keys(cfg?.agents?.entries || {})) {
    if (id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  }
  // Legacy compatibility for pre-2026.8 configs that used an array.
  for (const agent of Array.isArray(cfg?.agents?.list) ? cfg.agents.list : []) {
    if (typeof agent?.id === 'string' && agent.id.trim() && !ids.includes(agent.id.trim())) ids.push(agent.id.trim());
  }
  if (!ids.includes('main')) ids.unshift('main');
  return ids;
}

function getAgentIdFromSessionKey(key) {
  const match = String(key || '').match(/^agent:([^:]+):/);
  return match?.[1] || 'main';
}

function getSessionDisplayNameFromTrajectory(entry = {}, agentId = 'main') {
  const sessionId = entry.sessionId;
  if (!sessionId) return '';
  const file = path.join(getSessionStorePath(agentId), '..', `${sessionId}.trajectory.jsonl`);
  try {
    if (!fs.existsSync(file)) return '';
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-80).reverse();
    for (const line of lines) {
      let obj; try { obj = JSON.parse(line); } catch { continue; }
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

function hashSecret(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function ensureLocalMenuConfig() {
  const initial = { directChatDisplayName: '', sessionDisplayNames: {} };
  try {
    fs.mkdirSync(path.dirname(LOCAL_MENU_CONFIG), { recursive: true });
    if (!fs.existsSync(LOCAL_MENU_CONFIG)) {
      const tmpFile = `${LOCAL_MENU_CONFIG}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmpFile, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmpFile, LOCAL_MENU_CONFIG);
        fs.chmodSync(LOCAL_MENU_CONFIG, 0o600);
      } catch (err) {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        throw err;
      }
    }
  } catch {}
  const data = readJson(LOCAL_MENU_CONFIG, initial);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : initial;
}

function getTelegramBotToken() {
  const cfg = readJson(CONFIG, {});
  const token = cfg?.channels?.telegram?.botToken || cfg?.plugins?.entries?.telegram?.botToken || '';
  return typeof token === 'string' ? token.trim() : '';
}

function getCachedTelegramBotName() {
  const token = getTelegramBotToken();
  if (!token) return '';
  const tokenHash = hashSecret(token);
  const now = Date.now();
  if (telegramBotNameCache.value && telegramBotNameCache.tokenHash === tokenHash && now - telegramBotNameCache.ts < TELEGRAM_BOT_NAME_CACHE_TTL_MS) {
    return telegramBotNameCache.value;
  }
  return '';
}

async function refreshTelegramBotNameFromApi() {
  const token = getTelegramBotToken();
  if (!token) return '';
  const tokenHash = hashSecret(token);
  const cached = getCachedTelegramBotName();
  if (cached) return cached;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_BOT_NAME_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const text = await res.text().catch(() => '');
    clearTimeout(timeoutId);
    if (!res.ok) return '';
    let data; try { data = JSON.parse(text || '{}'); } catch { return ''; }
    const name = cleanSessionDisplayName(data?.result?.first_name || data?.result?.username || '');
    if (!data?.ok || !name) return '';
    telegramBotNameCache.value = name;
    telegramBotNameCache.tokenHash = tokenHash;
    telegramBotNameCache.ts = Date.now();
    return name;
  } catch (e) {
    clearTimeout(timeoutId);
    if (typeof _dbg === 'function') _dbg('refreshTelegramBotNameFromApi', e);
    return '';
  }
}


async function hydrateTelegramSessionNames(rows = []) {
  const token = getTelegramBotToken();
  if (!token) return rows;
  const targets = [...new Set(rows
    .filter((row) => /^agent:[^:]+:telegram:(group|direct):/.test(String(row.key || '')))
    .map((row) => ({ row, target: extractSessionTargetId(row.key) }))
    .filter(({ target }) => target))];
  await Promise.all(targets.map(async ({ row, target }) => {
    const cached = telegramChatNameCache.get(String(target));
    if (cached && Date.now() - cached.ts < TELEGRAM_BOT_NAME_CACHE_TTL_MS) {
      row.entry = { ...row.entry, ...cached.entry };
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_BOT_NAME_FETCH_TIMEOUT_MS);
      const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(target)}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !data.result) return;
      const chat = data.result;
      const name = cleanSessionDisplayName(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '');
      if (!name) return;
      const entry = /^-?\d+$/.test(String(target))
        ? { groupSubject: name, chatTitle: name }
        : { peerName: name, chatTitle: name };
      telegramChatNameCache.set(String(target), { entry, ts: Date.now() });
      row.entry = { ...row.entry, ...entry };
    } catch {}
  }));
  return rows;
}

function getDirectChatDisplayName(target) {
  const botName = getCachedTelegramBotName();
  if (botName) return botName;
  const localConfig = ensureLocalMenuConfig();
  const configured = cleanSessionDisplayName(localConfig.directChatDisplayName);
  if (configured) return configured;
  const names = localConfig.sessionDisplayNames && typeof localConfig.sessionDisplayNames === 'object' ? localConfig.sessionDisplayNames : {};
  return cleanSessionDisplayName(names[`telegram:direct:${target}`] || names[`direct:${target}`] || names[String(target)]);
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
  return getSessionDisplayNameFromTrajectory(entry, getAgentIdFromSessionKey(key));
}

function extractSessionTargetId(key) {
  const match = String(key || '').match(/^agent:[^:]+:[^:]+:(?:direct|group):(.+)$/);
  return match?.[1] || '';
}

function formatSessionKindLabel(key, entry = {}, duplicateNames = new Set()) {
  const text = String(key || '');
  const match = text.match(/^agent:([^:]+):([^:]+):(direct|group|slash):(.+)$/);
  if (match) {
    const [, agentId, , kind, target] = match;
    const friendlyName = getSessionFriendlyName(key, entry);
    if (kind === 'direct') {
      const directName = friendlyName || getDirectChatDisplayName(target);
      if (directName && directName !== target) return `TG私聊 【${directName}】 [${agentId}]`;
      return `TG私聊用户 [${agentId}]`;
    }
    if (kind === 'group') {
      if (friendlyName && friendlyName !== target) return `TG群聊 【${friendlyName}】 [${agentId}]`;
      return `TG群聊 [${agentId}]`;
    }
    return `TG Slash【${friendlyName || target}】`;
  }
  if (entry.kind) return `${entry.kind}【${getSessionFriendlyName(key, entry) || text}】`;
  return getSessionFriendlyName(key, entry) || text;
}

function formatSessionModelLabel(entry = {}) {
  const providerId = entry.providerOverride || entry.modelProvider || '';
  const model = entry.modelOverride || entry.model || '';
  const cfg = getWorkspaceCfg();
  if (!cfg) {
    if (providerId && model) return `${providerId} / ${model}`;
    return '配置不可用';
  }
  if (providerId && model) {
    const provider = cfg.models?.providers?.[providerId];
    const displayName = getProviderLabel(providerId, provider);
    return `${formatProviderDisplay(displayName, providerId)} / ${model}`;
  }
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
    const res = runCommand('openclaw', ['sessions', '--json', '--all-agents', '--active', '5'], { cwd: WORKSPACE, timeout: 8000 });
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
  // OpenClaw 2026.8.1 stores sessions in per-agent SQLite databases; use the
  // official CLI catalog first and retain the legacy JSON fallback for older installs.
  try {
    const res = runCommand('openclaw', ['sessions', '--json', '--all-agents', '--limit', 'all'], {
      cwd: WORKSPACE,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const data = JSON.parse(`${res.stdout || ''}`.trim() || '{}');
    const cliRows = (Array.isArray(data?.sessions) ? data.sessions : [])
      .filter((session) => /^agent:[^:]+:telegram:(group|direct):/.test(String(session?.key || '')))
      .map((session) => ({
        key: session.key,
        entry: {
          updatedAt: session.updatedAt,
          sessionId: session.sessionId,
          providerOverride: session.providerOverride,
          modelOverride: session.modelOverride,
          model: session.model,
          modelProvider: session.modelProvider,
        },
        agentId: session.agentId || getAgentIdFromSessionKey(session.key),
        storePath: session.storePath || '',
        updatedAt: Number(session.updatedAt || 0),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (cliRows.length) return { stores: [], rows: cliRows.slice(0, limit) };
  } catch {}

  const stores = [];
  const rows = [];
  for (const agentId of getConfiguredAgentIds()) {
    const storePath = getSessionStorePath(agentId);
    const store = readJson(storePath, {});
    stores.push({ agentId, storePath, store });
    for (const [key, entry] of Object.entries(store || {})) {
      if (!/^agent:[^:]+:telegram:(group|direct):/.test(String(key))) continue;
      rows.push({ key, entry: entry || {}, agentId, storePath, updatedAt: Number(entry?.updatedAt || 0) });
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return { stores, rows: rows.slice(0, limit) };
}

function patchSessionModelViaGateway(sessionKey, ref) {
  const result = runCommand('openclaw', [
    'gateway', 'call', 'sessions.patch',
    '--params', JSON.stringify({ key: sessionKey, model: ref }),
    '--json',
  ], {
    cwd: WORKSPACE,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = String(result.stdout || '').trim();
  try {
    const response = JSON.parse(output || '{}');
    if (response.ok === false || response.error) {
      return { ok: false, reason: response.error?.message || response.error || 'Gateway 拒绝会话模型切换。' };
    }
  } catch {
    if (result.status !== 0) {
      return {
        ok: false,
        reason: String(result.stderr || result.stdout || 'Gateway sessions.patch 调用失败').trim(),
        gatewayUnavailable: true,
      };
    }
    return { ok: false, reason: 'Gateway 返回了无法解析的结果。' };
  }
  if (result.status !== 0) return { ok: false, reason: 'Gateway sessions.patch 调用失败。' };
  return { ok: true };
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

function verifySessionModelOverrides(storePath, sessionKeys, ref) {
  const [providerId, modelId] = splitModelRef(ref);
  const failed = [];
  const verifyOnce = () => {
    const latest = readJson(storePath, {});
    return sessionKeys.filter((key) => {
      const entry = latest?.[key];
      return !entry || entry.providerOverride !== providerId || entry.modelOverride !== modelId;
    });
  };
  let mismatched = verifyOnce();
  if (mismatched.length && typeof SharedArrayBuffer !== 'undefined' && typeof Atomics?.wait === 'function') {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } catch {}
    mismatched = verifyOnce();
  }
  for (const key of mismatched) failed.push({ key, reason: '写入后校验失败,可能被 Gateway 运行时会话缓存覆盖。' });
  return failed;
}

function syncSessionModelOverrides(sessionKeys, ref) {
  const { stores } = listSyncableTelegramSessions(1000);
  const keys = [...new Set(sessionKeys.filter(Boolean))];
  let synced = 0;
  const syncedKeys = [];
  const fallbackRows = [];
  const failed = [];
  for (const key of keys) {
    const gatewayResult = patchSessionModelViaGateway(key, ref);
    if (gatewayResult.ok) {
      synced += 1;
      syncedKeys.push(key);
      continue;
    }
    if (!gatewayResult.gatewayUnavailable) {
      failed.push({ key, reason: gatewayResult.reason });
      continue;
    }
    const storeInfo = stores.find((item) => Object.prototype.hasOwnProperty.call(item.store, key));
    const result = applySessionModelOverrideInStore(storeInfo?.store, key, ref);
    if (result.ok) {
      synced += 1;
      syncedKeys.push(key);
      fallbackRows.push({ key, storeInfo });
    } else {
      failed.push({ key, reason: result.reason });
    }
  }
  let backup = '';
  let verifyFailed = [];
  for (const group of new Map(fallbackRows.map((row) => [row.storeInfo?.storePath, row])).entries()) {
    const [storePath] = group;
    const rowsForStore = fallbackRows.filter((row) => row.storeInfo?.storePath === storePath);
    if (!storePath) continue;
    const storeInfo = rowsForStore[0].storeInfo;
    backup = backup || `${storePath}.bak.menu-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(storePath, backup);
    // 写入前重新读取一次,最小合并,避免覆盖 Gateway 并发写入的其他 session
    const freshStore = readJson(storePath, {});
    for (const row of rowsForStore) {
      if (storeInfo.store[row.key]) freshStore[row.key] = storeInfo.store[row.key];
    }
    writeJson(storePath, freshStore);
    verifyFailed.push(...verifySessionModelOverrides(storePath, rowsForStore.map((row) => row.key), ref));
  }
  return { ok: failed.length === 0 && verifyFailed.length === 0, synced, syncedKeys, failed, verifyFailed, backup };
}

function deleteTelegramSessionRecords(sessionKeys) {
  const keys = [...new Set(sessionKeys.filter(Boolean))];
  if (!keys.length) return { ok: true, deleted: 0 };

  // OpenClaw 2026.8.1 owns session state in SQLite. Delete through the
  // official Gateway-backed CLI so transcripts and live artifacts are cleaned up safely.
  const listed = listSyncableTelegramSessions(1000).rows;
  if (listed.some((row) => row.storePath === '' || row.entry?.sessionId)) {
    const rows = keys.map((key) => listed.find((row) => row.key === key)).filter(Boolean);
    const failed = [];
    let deleted = 0;
    for (const row of rows) {
      const args = ['sessions', 'delete', row.key, '--yes', '--json'];
      if (row.agentId) args.push('--agent', row.agentId);
      const result = runCommand('openclaw', args, { cwd: WORKSPACE, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      if (result.status === 0) deleted += 1;
      else failed.push(String(result.stderr || result.stdout || '官方会话删除失败').trim());
    }
    if (rows.length) return { ok: failed.length === 0, deleted, failed };
  }

  // Legacy OpenClaw versions used per-agent sessions.json; retain a safe fallback.
  const stores = listSyncableTelegramSessions(1000).stores;
  let deleted = 0;
  for (const storeInfo of stores) {
    const existingKeys = keys.filter((key) => Object.prototype.hasOwnProperty.call(storeInfo.store || {}, key));
    if (!existingKeys.length) continue;
    const freshStore = readJson(storeInfo.storePath, {});
    for (const key of existingKeys) {
      if (Object.prototype.hasOwnProperty.call(freshStore, key)) {
        delete freshStore[key];
        deleted += 1;
      }
    }
    writeJson(storeInfo.storePath, freshStore);
  }
  return deleted ? { ok: true, deleted } : { ok: false, deleted: 0, reason: '会话不存在或无法定位会话存储。' };
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
  await refreshTelegramBotNameFromApi();
  while (true) {
    const { rows: rawRows } = listSyncableTelegramSessions(1000);
    const cfg = readJson(CONFIG, {});
    const allowedRows = rawRows.filter((row) => isModelAllowedByPolicy(cfg, ref, row.agentId || getAgentIdFromSessionKey(row.key)));
    const blockedCount = rawRows.length - allowedRows.length;
    const rows = sortTelegramSessionsForMenu(allowedRows);
    await hydrateTelegramSessionNames(rows);
    if (!rows.length) {
      if (rawRows.length && blockedCount) warn('该模型不在现有 Telegram 会话所属 Agent 的 modelPolicy.allow 中。');
      else info('未找到可同步的 Telegram 群/私聊会话,将只设置默认模型。');
      return { action: 'selected', skipped: true, sessionKeys: [], setDefaultOnly: true };
    }
    if (blockedCount) info(`已隐藏 ${blockedCount} 个无权使用该模型的 Agent 会话。`);

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
  const cfg = getWorkspaceCfg();
  if (!cfg) return `${providerId} / ${modelId}`;
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
  if (kind === 'direct') {
    const directName = getDirectChatDisplayName(target) || friendlyName;
    if (directName && directName !== target) return directName;
    return '私聊用户';
  }
  if (kind === 'group') {
    if (friendlyName && friendlyName !== target) return friendlyName;
    return '群聊';
  }
  return friendlyName || target || '会话';
}

function describeSessionTargets(sessionKeys = []) {
  const { rows: allRows } = listSyncableTelegramSessions(1000);
  const selectedRows = [...new Set((sessionKeys || []).filter(Boolean))]
    .map((key) => ({ key, entry: allRows.find((item) => item.key === key)?.entry || {} }));
  const groupNames = selectedRows
    .filter((row) => /^agent:[^:]+:telegram:group:/.test(String(row.key || '')))
    .map((row) => getSessionTargetDisplayName(row.key, row.entry))
    .filter(Boolean);
  const directNames = selectedRows
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
  if (result.verifyFailed?.length) {
    warn(`${result.verifyFailed.length} 个会话写入后校验未通过,可能被 Gateway 运行时会话缓存覆盖。`);
    warn('如果刚切换的模型没有立即生效,请稍后重试或手动重启 Gateway。');
  }
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
  const cfg = getWorkspaceCfg();
  if (!cfg) return color('配置不可用', C.red);
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
  try { return JSON.parse(JSON.stringify(fallback)); } catch { return fallback; }
}

function atomicWriteJsonFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // 若目标已存在(如修复损坏文件时),保留原权限/属主
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      fs.chmodSync(tmp, st.mode & 0o7777);
      try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* 非 root 时忽略 */ }
    }
  } catch { /* 尽力保留权限,失败不阻断 */ }
  fs.renameSync(tmp, file);
}

function ensureJsonFile(file, fallback, options = {}) {
  const { label = path.basename(file), verbose = false } = options;
  const initial = cloneFallback(fallback);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      atomicWriteJsonFile(file, initial);
      if (verbose) info(`首次使用:已自动创建 ${label}`);
      return initial;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      const corruptPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(file, corruptPath); } catch {}
      if (verbose) warn(`${label} 内容不是合法 JSON,已备份为:${path.basename(corruptPath)},并重置为默认结构。`);
      atomicWriteJsonFile(file, initial);
      return initial;
    }
    if (Array.isArray(fallback)) {
      if (Array.isArray(parsed)) return parsed;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    const corruptPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, corruptPath); } catch {}
    atomicWriteJsonFile(file, initial);
    if (verbose) warn(`${label} 结构无效,已备份为:${path.basename(corruptPath)},并重置为默认结构。`);
    return initial;
  } catch (err) {
    if (verbose) danger(`处理 ${label} 失败:${err.message}`);
    return initial;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // 覆盖已存在文件时保留原权限/属主,避免换文件丢失敏感文件的权限位
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      fs.chmodSync(tmp, st.mode & 0o7777);
      try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* 非 root 或跨用户时忽略 */ }
    }
  } catch { /* 尽力保留权限,失败不阻断写入 */ }
  fs.renameSync(tmp, file);
}

function applyConfigPatch(patch, options = {}) {
  const args = ['config', 'patch', '--stdin'];
  if (options.dryRun) args.push('--dry-run');
  for (const replacePath of options.replacePaths || []) {
    args.push('--replace-path', replacePath);
  }
  return runCommand('openclaw', args, {
    input: JSON.stringify(patch, null, 2),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function ensureConfigSkeleton() {
  let created = false;
  let corrupted = false;
  let cfg;
  if (!fs.existsSync(CONFIG)) {
    cfg = {};
    created = true;
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        corrupted = true;
        cfg = null;
      } else {
        cfg = parsed;
      }
    } catch {
      corrupted = true;
      cfg = null;
    }
  }
  if (corrupted) return { cfg: null, created: false, corrupted: true };
  if (!cfg.models || typeof cfg.models !== 'object' || Array.isArray(cfg.models)) cfg.models = {};
  if (!cfg.models.providers || typeof cfg.models.providers !== 'object' || Array.isArray(cfg.models.providers)) cfg.models.providers = {};
  if (!cfg.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) cfg.agents = {};
  if (!cfg.agents.defaults || typeof cfg.agents.defaults !== 'object' || Array.isArray(cfg.agents.defaults)) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.models || typeof cfg.agents.defaults.models !== 'object' || Array.isArray(cfg.agents.defaults.models)) cfg.agents.defaults.models = {};
  return { cfg, created, corrupted: false };
}

function loadWorkspaceState(options = {}) {
  const { verbose = false } = options;
  const ensured = ensureConfigSkeleton();
  if (ensured.corrupted) {
    return {
      ok: false,
      cfg: null,
      displayNames: ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose }),
      recentModels: ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json', verbose }),
      reason: `OpenClaw 主配置文件不是合法 JSON:${CONFIG}`,
      hint: '请先修复 openclaw.json,或从同目录 openclaw.json-* 备份恢复。菜单不会覆盖损坏的主配置。',
    };
  }
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

function getWorkspaceCfg(options = {}) {
  const state = loadWorkspaceState(options);
  if (!state.ok) return null;
  if (!state.cfg || typeof state.cfg !== 'object' || Array.isArray(state.cfg)) return null;
  return state.cfg;
}

function getWorkspaceSkillsDir() {
  return path.join(STATE_DIR, 'workspace', 'skills');
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
      try {
        results[current] = await worker(items[current], current);
      } catch (err) {
        results[current] = { error: err };
      }
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

function explainHttpStatus(status) {
  const code = Number(status);
  const reasons = {
    400: '请求参数错误',
    401: '认证失败/API Key无效',
    402: '余额不足/需要付费',
    403: '权限不足/Key无权限',
    404: '接口路径或模型不存在',
    408: '请求超时',
    409: '请求冲突',
    413: '请求体过大',
    415: '请求格式不支持',
    422: '参数校验失败',
    429: '请求过多/限流',
    500: '服务端内部错误',
    501: '接口未实现',
    502: '上游网关异常',
    503: '服务暂不可用',
    504: '网关超时',
  };
  if (reasons[code]) return reasons[code];
  if (code >= 400 && code < 500) return '客户端请求异常';
  if (code >= 500 && code < 600) return '服务端或上游异常';
  return '';
}

function formatHttpStatusError(status) {
  const reason = explainHttpStatus(status);
  return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
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
    const timeoutId = setTimeout(() => controller.abort(), PROVIDER_STATUS_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latency = Date.now() - start;
      const result = {
        online: res.ok,
        reachable: true,
        latency,
        httpStatus: res.status,
        state: res.ok ? 'available' : 'reachable_error',
        error: res.ok ? null : formatHttpStatusError(res.status),
      };
      providerStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return { ...result, _cached: false };
    } catch (err) {
      clearTimeout(timeoutId);
      const result = {
        online: false,
        reachable: false,
        latency: null,
        state: 'offline',
        error: err.name === 'AbortError' ? '超时' : err.message,
      };
      providerStatusCache.set(cacheKey, { ts: Date.now(), value: result });
      return { ...result, _cached: false };
    }
  } catch {
    return { online: false, latency: null, error: 'network error', _cached: false };
  }
}

function getCurrentModelRef() {
  const cfg = getWorkspaceCfg();
  if (!cfg) return '';
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
  const cfg = getWorkspaceCfg();
  if (!cfg) return false;
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
  if (
    errMsg.includes('billing') ||
    errMsg.includes('insufficient balance') ||
    errMsg.includes('insufficient credits') ||
    errMsg.includes('out of credits') ||
    errMsg.includes('run out of credits') ||
    errMsg.includes('quota exceeded') ||
    errMsg.includes('余额不足') ||
    errMsg.includes('额度不足') ||
    errMsg.includes('欠费')
  ) {
    return { status: 'billing_error', error: summarizeErrorMessage(rawMessage || 'API 余额/额度不足') };
  }
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
  let buffer = '';
  let returnedModel = '';
  let content = '';
  let reasoningContent = '';
  let usage = null;
  let chunkCount = 0;

  const handleLine = async (rawLine) => {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) return null;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return null;
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
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      rawText += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const early = await handleLine(rawLine);
        if (early) return early;
      }
    }
  } finally {
    const tail = decoder.decode();
    rawText += tail;
    buffer += tail;
  }
  if (buffer.trim()) await handleLine(buffer);
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
        online: false,
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
    const errText = String(currentStatus?.error || '');
    const isTimeout = currentStatus?.status === 'timeout' || /超时|timeout/i.test(errText);
    warn(`该模型检测未通过:${formatModelCheckResult(currentStatus)}`);
    if (currentStatus?.status === 'billing_error') {
      warn('检测到 API 余额/额度不足;如果仍然切换,实际调用可能继续失败或回退到其他模型。');
    } else if (currentStatus?.status === 'auth_failed') {
      warn('检测到 API Key/权限异常;如果仍然切换,实际调用可能失败。');
    } else if (currentStatus?.status === 'model_not_found') {
      warn('检测到模型不存在或服务商未开放该模型;如果仍然切换,实际调用可能失败。');
    } else if (isTimeout) {
    }
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
  const state = status?.state || (status?.online ? 'available' : status?.reachable ? 'reachable_error' : 'offline');
  if (state === 'available') {
    return {
      statusDot: color('●', latencyColor),
      latencyText: status?.latency ? color(`在线 ${status.latency}ms`, latencyColor) : color('在线', C.green, C.bold),
    };
  }
  if (state === 'reachable_error') {
    const detail = status?.error ? ` ${status.error}` : '';
    return {
      statusDot: color('●', C.yellow),
      latencyText: status?.latency ? color(`在线但异常 ${status.latency}ms${detail}`, C.yellow, C.bold) : color(`在线但异常${detail}`, C.yellow, C.bold),
    };
  }
  return {
    statusDot: color('●', C.red, C.blink),
    latencyText: color('离线/不可达', C.red, C.bold),
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

function formatProviderStatusForProviderList(status, options = {}) {
  const showError = options.showError !== false;
  if (status?.checking) return color('检测中', C.yellow, C.bold);
  const latencyColor = status?.latency < 200 ? C.green : status?.latency < 500 ? C.yellow : C.magenta;
  const state = status?.state || (status?.online ? 'available' : status?.reachable ? 'reachable_error' : 'offline');
  if (state === 'available') {
    const latencyText = status?.latency ? color(`${status.latency}ms`, latencyColor, C.bold) : '';
    return latencyText ? `${color('在线', C.green, C.bold)} | ${latencyText}` : color('在线', C.green, C.bold);
  }
  if (state === 'reachable_error') {
    const detail = showError && status?.error ? ` | ${color(status.error, C.gray)}` : '';
    const latencyText = status?.latency ? ` | ${color(`${status.latency}ms`, latencyColor, C.bold)}` : '';
    return `${color('在线但异常', C.yellow, C.bold)}${latencyText}${detail}`;
  }
  return color('离线/不可达', C.red, C.bold);
}

function providersState(options = {}) {
  const { respectPolicy = true } = options;
  const state = loadWorkspaceState();
  const cfg = state.cfg && typeof state.cfg === 'object' && !Array.isArray(state.cfg) ? state.cfg : null;
  if (!cfg) return [];
  const displayNames = state.displayNames || {};
  const providers = cfg.models?.providers || {};
  const modelConfig = cfg.agents?.defaults?.model;
  const primary = typeof modelConfig === 'string' ? modelConfig : (modelConfig?.primary || '');
  return Object.entries(providers)
    .filter(([id, provider]) => {
      if (!respectPolicy) return true;
      const models = Array.isArray(provider?.models) ? provider.models : [];
      return models.some((model) => isModelAllowedByPolicy(cfg, `${id}/${model.id}`));
    })
    .map(([id, provider]) => ({
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

function inferProviderDisplayName(provider, fallback = '') {
  if (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string') {
    const inferred = String(provider.models[0].name).split(' / ')[0].trim();
    if (inferred) return inferred;
  }
  return fallback;
}

function collectProviderDisplayNames(cfg = {}, displayNames = {}) {
  const providers = cfg.models?.providers || {};
  const rows = [];
  for (const [id, provider] of Object.entries(providers)) {
    const names = new Set();
    if (displayNames[id]) names.add(String(displayNames[id]).trim());
    const inferred = inferProviderDisplayName(provider, id);
    if (inferred) names.add(String(inferred).trim());
    for (const name of names) {
      if (name) rows.push({ id, name });
    }
  }
  return rows;
}

function findProviderDisplayNameConflict(name, cfg = {}, displayNames = {}, options = {}) {
  const text = String(name || '').trim();
  if (!text) return null;
  const excludeId = options.excludeId || '';
  const lowered = text.toLowerCase();
  return collectProviderDisplayNames(cfg, displayNames).find((item) => item.id !== excludeId && item.name.toLowerCase() === lowered) || null;
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
  const spawnOptions = options.input === undefined
    ? { stdio: 'inherit' }
    : { input: options.input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] };
  let res = spawnSync(process.execPath, [script, ...args], spawnOptions);
  if (retry && res.status !== 0) {
    info('首次同步失败,正在重试...');
    res = spawnSync(process.execPath, [script, ...args], spawnOptions);
  }
  return typeof res.status === 'number' ? res.status : 1;
}

function runNodeBuffered(script, args = [], options = {}) {
  const label = options.label || path.basename(script || '子脚本');
  if (script && !fs.existsSync(script)) {
    return Promise.resolve({ status: 127, output: `缺少辅助脚本:${label}` });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (err) => resolve({ status: 1, output: err.message }));
    child.on('close', (code, signal) => resolve({
      status: typeof code === 'number' ? code : 1,
      output: output.trim(),
      signal,
    }));
  });
}

function isValidProviderId(value) {
  return /^[a-zA-Z0-9_-]+$/.test(String(value || ''));
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
  rewriteSelectionField('utilityModel');
  for (const field of ['mediaModels']) {
    if (defaults[field] !== undefined) defaults[field] = rewriteProviderRefsDeep(defaults[field], oldName, newName);
  }
  const policyAllow = rewriteProviderModelPolicy(defaults, oldName, newName);
  if (policyAllow) {
    if (!defaults.modelPolicy || typeof defaults.modelPolicy !== 'object') defaults.modelPolicy = {};
    defaults.modelPolicy.allow = policyAllow;
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
  if (defaults.mediaModels !== undefined) {
    const removeRefs = (value) => {
      if (typeof value === 'string') return isProviderRef(value, name) ? null : value;
      if (Array.isArray(value)) return value.map(removeRefs).filter((item) => item !== null);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const next = removeRefs(item);
        if (next !== null) out[key] = next;
      }
      return out;
    };
    const remaining = removeRefs(defaults.mediaModels);
    if (remaining && Object.keys(remaining).length) defaults.mediaModels = remaining;
    else delete defaults.mediaModels;
  }
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

function repairModelSelectionForSyncedProvider(config, providerName, validModelIds = []) {
  const defaults = config.agents?.defaults;
  if (!defaults) return { changed: false, messages: [] };
  const validRefs = new Set(validModelIds.map((id) => `${providerName}/${id}`));
  const fallbackRef = validModelIds.length ? `${providerName}/${validModelIds[0]}` : '';
  const messages = [];
  let changed = false;

  const isSameProviderRef = (ref) => typeof ref === 'string' && splitModelRef(ref)[0]?.toLowerCase() === providerName.toLowerCase();
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

  for (const field of ['model', 'imageModel', 'pdfModel', 'audioModel', 'videoGenerationModel', 'musicGenerationModel', 'utilityModel', 'mediaModels']) {
    repairString(field);
    repairObject(field);
  }
  return { changed, messages };
}

function guessInputCaps(id) {
  return /(vision|vl|image|4o|gemini|gpt-4\.1|o4)/i.test(id) ? ['text', 'image'] : ['text'];
}

async function fetchProviderModelIds(provider) {
  const baseUrl = normalizeAndValidateBaseUrl(provider?.baseUrl);
  if (!baseUrl) throw new Error('Base URL 格式无效');
  const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_SYNC_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const ids = [...new Set(rows.map((item) => item?.id).filter(Boolean))];
    if (!ids.length) throw new Error('No model IDs found in /models response');
    return ids;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时:${PROVIDER_SYNC_FETCH_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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

async function backPrompt(ask) {
  console.log(color('操作完成', C.green, C.bold));
  console.log(color('按任意键继续...', C.white, C.bold));
  await ask('');
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
  await mapWithConcurrency(rows, Math.min(5, rows.length), async (row) => {
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
    const models = (Array.isArray(provider?.models) ? provider.models : [])
      .filter((model) => isModelAllowedByPolicy(fresh, `${chosenProvider.id}/${model.id}`));
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
        const patchRes = applyConfigPatch({
          agents: { defaults: { model: { primary: ref } } },
        });
        if (patchRes.status !== 0) {
          danger('写入默认模型配置失败。');
          if (patchRes.stdout) console.log(String(patchRes.stdout).trim());
          if (patchRes.stderr) console.log(String(patchRes.stderr).trim());
          await backPrompt(ask);
          continue;
        }
      }
      addRecentModel(ref, `${formatProviderDisplay(chosenProvider.displayName, chosenProvider.id)} / ${model.id}`, chosenProvider.displayName);
      applySelectedSessionSync(sessionSelection, ref);
      if (shouldUpdateDefault) success(`默认模型已设为:${formatProviderDisplay(chosenProvider.displayName, chosenProvider.id)} / ${model.id}`);
      await backPrompt(ask);
      break;
    }
    break;
  }
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
  if (!isValidProviderId(providerName)) return warn('provider id 格式无效,只能包含字母、数字、下划线(_)和短横线(-)。');
  if (state.cfg.models?.providers?.[providerName]) return warn(`Provider 已存在:${providerName},请换一个 provider id 或先修改/删除旧 API。`);
  const displayName = await ask(color('输入显示名称（中文可填，直接回车则同 provider id）：', C.bold)) || providerName;
  const displayNameConflict = findProviderDisplayNameConflict(displayName, state.cfg, state.displayNames, { excludeId: providerName });
  if (displayNameConflict) return warn(`显示名称已被 ${displayNameConflict.id} 使用:${displayName},请换一个显示名称。`);
  const baseUrlInput = await ask(color('输入 Base URL（例如 https://api.example.com/v1）：', C.bold));
  if (!baseUrlInput) return warn('Base URL 不能为空。');
  const baseUrl = normalizeAndValidateBaseUrl(baseUrlInput);
  if (!baseUrl) return warn('Base URL 格式无效,请输入以 http:// 或 https:// 开头的完整 URL。');
  const apiKey = await ask(color('输入 API Key：', C.bold));
  if (!apiKey) return warn('API Key 不能为空。');
  const helperPath = path.join(__dirname, 'add-provider.mjs');
  if (!fs.existsSync(helperPath)) {
    danger('缺少外部脚本:add-provider.mjs');
    info('请把 add-provider.mjs 放回当前脚本目录后再重试。');
    await backPrompt(ask);
    return;
  }
  const addPayload = JSON.stringify({ providerName, providerDisplayName: displayName, baseUrl, apiKey });
  const result = { code: runNode(helperPath, ['--stdin'], { retry: true, label: 'add-provider.mjs', input: addPayload }) };
  const freshCfg = getWorkspaceCfg() || {};
  const exists = !!freshCfg.models?.providers?.[providerName];
  if (exists && result.code === 0) {
    success('API 添加成功,模型同步完成。');
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
    const [primaryProviderId] = splitModelRef(primaryRef);
    const isCurrentProvider = primaryProviderId.toLowerCase() === row.id.toLowerCase();

    section(`删除 ${formatProviderRow(row)}`);
    console.log(`${color('模型数量', C.gray)}  ${color(`${modelCount} 个`, C.yellow, C.bold)}`);
    if (isCurrentProvider) {
      danger('该 API 正被当前默认主模型使用,不能直接删除。');
      info(`当前默认模型:${primaryRef}`);
      info('请先到 [1] 换模型,切换到其他 Provider 后再回来删除。');
      await backPrompt(ask);
      continue;
    }
    const confirm = await ask(color(`确认删除 API ${formatProviderRow(row)}？(y/N): `, C.yellow, C.bold));
    if (confirm.toLowerCase() !== 'y') {
      info('操作已取消。');
      continue;
    }
    const helperPath = path.join(__dirname, 'provider-manage.mjs');
    if (!fs.existsSync(helperPath)) {
      danger('缺少外部脚本:provider-manage.mjs');
      info('请把 provider-manage.mjs 放回当前脚本目录后再重试。');
      await backPrompt(ask);
      continue;
    }
    const status = runNode(helperPath, ['remove', row.id], { label: 'provider-manage.mjs' });
    const latestCfg = readJson(CONFIG, {});
    const exists = !!latestCfg.models?.providers?.[row.id];
    if (status === 0 && !exists) {
      success('API 删除成功。');
      success('配置已更新。');
    } else {
      danger(`API 删除失败:${row.displayName},请检查配置或重试。`);
      info('请查看上方报错详情。');
    }
    await backPrompt(ask);
    continue;
  }
}

async function syncAllProviders(ask) {
  // 同步本身也是修复入口，必须包含当前被白名单漏掉的 Provider。
  const rows = providersState({ respectPolicy: false });
  if (!rows.length) {
    warn('当前没有已配置的 API 提供商。');
    return;
  }
  const beforeCfg = readJson(CONFIG, {});
  let nextCfg; try { nextCfg = JSON.parse(JSON.stringify(beforeCfg)); } catch { warn('序列化配置失败，跳过同步。'); return false; }
  const beforeIdsMap = new Map(rows.map((row) => [row.id, getProviderModelIds(beforeCfg, row.id)]));
  info(`开始同步全部 ${rows.length} 个 API，请稍等...`);
  const patchPayload = { models: { providers: {} }, agents: { defaults: { models: {} } } };
  let nextModelPolicyAllow = getExplicitModelPolicyAllow(beforeCfg)
    ? [...getExplicitModelPolicyAllow(beforeCfg)]
    : null;
  const replacePaths = [];
  let successCount = 0, failCount = 0;
  let addedTotal = 0, removedTotal = 0, unchangedProviders = 0;
  const detailLines = [];
  const repairedDefaultLines = [];
  for (const [idx, row] of rows.entries()) {
    console.log('');
    console.log(`${progressBar(idx + 1, rows.length)} 正在同步 ${row.displayName}...`);
    const startedAt = Date.now();
    let item;
    try {
      const provider = beforeCfg.models?.providers?.[row.id];
      const ids = await fetchProviderModelIds(provider);
      item = { row, status: 0, ids, durationMs: Date.now() - startedAt };
    } catch (err) {
      item = { row, status: 1, output: err.message, durationMs: Date.now() - startedAt };
    }
    const beforeProvider = beforeCfg.models?.providers?.[row.id] || {};
    const beforeIds = beforeIdsMap.get(row.id) || [];
    const afterIds = item.status === 0 ? [...item.ids].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN')) : beforeIds;
    const { added, removed } = formatModelDelta(beforeIds, afterIds);
    if (item.status === 0) {
      successCount++;
      addedTotal += added.length;
      removedTotal += removed.length;
      if (added.length === 0 && removed.length === 0) unchangedProviders++;
      const providerPatch = {
        ...beforeProvider,
        models: item.ids.map((id) => normalizeModel(row.displayName || row.id, id)),
      };
      patchPayload.models.providers[row.id] = providerPatch;
      if (!nextCfg.models) nextCfg.models = {};
      if (!nextCfg.models.providers) nextCfg.models.providers = {};
      nextCfg.models.providers[row.id] = providerPatch;
      const repairedDefaults = repairModelSelectionForSyncedProvider(nextCfg, row.id, item.ids);
      if (repairedDefaults.changed) {
        for (const msg of repairedDefaults.messages) repairedDefaultLines.push(`${row.id}: ${msg}`);
      }
      replacePaths.push(`models.providers.${row.id}.models`);
      patchPayload.agents.defaults.models[`${row.id}/*`] = {};
      if (nextModelPolicyAllow) {
        const wildcard = `${row.id}/*`;
        if (!nextModelPolicyAllow.includes(wildcard)) nextModelPolicyAllow.push(wildcard);
      }
      for (const [ref, value] of Object.entries(beforeCfg.agents?.defaults?.models || {})) {
        if (ref === `${row.id}/*`) continue;
        const [pfx] = ref.split('/');
        const isEmptyObject = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
        if (pfx.toLowerCase() === row.id.toLowerCase() && isEmptyObject) patchPayload.agents.defaults.models[ref] = null;
      }
      const seconds = item.durationMs ? `,耗时 ${(item.durationMs / 1000).toFixed(1)}s` : '';
      const resultLine = color(`✅ ${formatProviderRow(row)}: 新增 ${added.length} 个,删除 ${removed.length} 个,当前 ${item.ids.length} 个${seconds}`, C.white);
      console.log(resultLine);
      detailLines.push(color(`✅ ${formatProviderRow(row)}: 新增 ${added.length} 个,删除 ${removed.length} 个,当前 ${item.ids.length} 个`, C.white));
      for (const line of formatModelListBlock('➕', '新增模型', added)) detailLines.push(color(line, C.white));
      for (const line of formatModelListBlock('➖', '删除模型', removed)) detailLines.push(color(line, C.white));
    } else {
      failCount++;
      const seconds = item.durationMs ? `,耗时 ${(item.durationMs / 1000).toFixed(1)}s` : '';
      const reason = String(item.output || '/models 探测失败').split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || '/models 探测失败';
      const failLine = color(`⚠ ${formatProviderRow(row)}: ${reason}${seconds}`, C.white);
      console.log(failLine);
      detailLines.push(color(`⚠ ${formatProviderRow(row)}: /models 探测失败`, C.white));
      detailLines.push(color(`新增 0 个,删除 0 个,当前 ${beforeIds.length} 个`, C.white));
    }
  }
  if (successCount > 0) {
    const selectionPatch = buildDefaultSelectionPatch(nextCfg.agents?.defaults || {}, beforeCfg.agents?.defaults || {});
    patchPayload.agents.defaults = { ...selectionPatch, models: patchPayload.agents.defaults.models };
    if (nextModelPolicyAllow) patchPayload.agents.defaults.modelPolicy = { allow: nextModelPolicyAllow };
    info('正在写入配置，请稍等...');
    const patchRes = applyConfigPatch(patchPayload, { replacePaths });
    if (patchRes.status !== 0) {
      danger('批量写入配置失败。');
      if (patchRes.stdout) console.log(String(patchRes.stdout).trim());
      if (patchRes.stderr) console.log(String(patchRes.stderr).trim());
      await backPrompt(ask);
      return;
    }
  }
  console.log(color(`同步摘要：共检查 ${rows.length} 个提供商，新增 ${addedTotal} 个模型，移除 ${removedTotal} 个模型，${unchangedProviders} 个提供商模型未变化。`, C.white));
  for (const line of detailLines) console.log(line);
  if (repairedDefaultLines.length) {
    info('已修复默认模型引用:');
    for (const line of repairedDefaultLines) console.log(color(`- ${line}`, C.white));
  }
  if (failCount > 0) {
    info('若有失败，请查看上方对应 API 的报错详情（常见原因：Base URL 错误、API Key 无效、/models 接口异常、返回空模型列表）。');
  }
  if (successCount > 0) {
    success('配置已更新。');
  } else {
    danger('全部同步失败,未写入任何配置更新。');
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
    await mapWithConcurrency(rows, Math.min(5, rows.length), async (row) => {
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
    const helperPath = path.join(__dirname, 'provider-manage.mjs');
    if (!fs.existsSync(helperPath)) {
      danger('缺少外部脚本:provider-manage.mjs');
      info('请把 provider-manage.mjs 放回当前脚本目录后再重试。');
      await backPrompt(ask);
      continue;
    }
    const status = runNode(helperPath, ['sync', row.id], { label: 'provider-manage.mjs' });
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
        if (!isValidProviderId(newProviderId)) {
          warn('英文 ID 格式无效,只能包含字母、数字、下划线(_)和短横线(-)。');
          continue;
        }
      }
      if (action === '2' || action === '5') {
        console.log('');
        const input = await ask(color(`当前中文显示名: ${row.displayName}\n请输入新的中文显示名(直接回车保持不变): `, C.bold));
        newDisplayName = input.trim() ? input.trim() : row.displayName;
        const displayNameConflict = findProviderDisplayNameConflict(newDisplayName, cfg, displayNames, { excludeId: row.id });
        if (displayNameConflict) {
          warn(`显示名称已被 ${displayNameConflict.id} 使用:${newDisplayName},请换一个显示名称。`);
          continue;
        }
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

      const oldProviderId = row.id;
      const providerIdChanged = newProviderId && newProviderId !== oldProviderId;
      if (providerIdChanged) {
        const providers = cfg.models.providers || {};
        if (providers[newProviderId]) {
          danger(`新的英文 ID 已存在:${newProviderId}`);
          continue;
        }
      }

      const originalModelRefs = { ...(cfg.agents?.defaults?.models || {}) };
      const originalAgentEntries = JSON.parse(JSON.stringify(cfg.agents?.entries || {}));

      if (providerIdChanged) {
        const providers = cfg.models.providers || {};
        providers[newProviderId] = providers[oldProviderId];
        delete providers[oldProviderId];
        rewriteProviderRefsInDefaults(cfg, oldProviderId, newProviderId);
        rewriteProviderRefsInAgentEntries(cfg, oldProviderId, newProviderId);
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

      if (Array.isArray(provider.models)) {
        provider.models = provider.models.map((model) => ({
          ...model,
          name: `${newDisplayName} / ${model.id}`,
        }));
      }

      const modelRefPatch = {};
      if (providerIdChanged) {
        for (const [key, value] of Object.entries(originalModelRefs)) {
          const [refProvider, ...refParts] = key.split('/');
          if (String(refProvider).toLowerCase() !== String(oldProviderId).toLowerCase()) continue;
          const suffix = refParts.join('/');
          modelRefPatch[key] = null;
          modelRefPatch[`${newProviderId}/${suffix}`] = value;
        }
        modelRefPatch[`${oldProviderId}/*`] = null;
        modelRefPatch[`${newProviderId}/*`] = {};
      }
      const patchPayload = {
        models: { providers: { [row.id]: provider } },
      };
      if (Object.keys(modelRefPatch).length) {
        patchPayload.agents = { defaults: { models: modelRefPatch } };
      }
      if (providerIdChanged) {
        const defaultsPatch = {
          ...buildDefaultSelectionPatch(cfg.agents?.defaults || {}, readJson(CONFIG, {}).agents?.defaults || {}),
          models: modelRefPatch,
        };
        const modelPolicyAllow = getExplicitModelPolicyAllow(cfg);
        if (modelPolicyAllow) defaultsPatch.modelPolicy = { allow: modelPolicyAllow };
        const agentEntriesPatch = {};
        for (const [agentId, entry] of Object.entries(cfg.agents?.entries || {})) {
          if (JSON.stringify(entry) !== JSON.stringify(originalAgentEntries[agentId])) agentEntriesPatch[agentId] = entry;
        }
        patchPayload.agents = { defaults: defaultsPatch };
        if (Object.keys(agentEntriesPatch).length) patchPayload.agents.entries = agentEntriesPatch;
      }
      if (providerIdChanged) patchPayload.models.providers[oldProviderId] = null;
      const patchRes = applyConfigPatch(patchPayload);
      if (patchRes.status !== 0) {
        danger('API 配置写入失败。');
        if (patchRes.stdout) console.log(String(patchRes.stdout).trim());
        if (patchRes.stderr) console.log(String(patchRes.stderr).trim());
        await backPrompt(ask);
        break;
      }
      writeJson(DISPLAY_NAMES, displayNames);
      const checked = await detectProviderStatus(provider);
      success(`API 配置修改成功。`);
      info(`修改后检测:${stripAnsi(formatProviderStatusCompact(checked))}`);
      const shouldSyncModels = String(oldBaseUrl || '') !== String(newBaseUrl || '') || String(oldApiKey || '') !== String(newApiKey || '');
      if (shouldSyncModels) {
        info('检测到 Base URL 或 API Key 已变更，正在自动同步模型列表...');
        const beforeCfg = readJson(CONFIG, {});
        const beforeIds = getProviderModelIds(beforeCfg, row.id);
        const helperPath = path.join(__dirname, 'provider-manage.mjs');
        if (!fs.existsSync(helperPath)) {
          warn('缺少外部脚本:provider-manage.mjs，已跳过自动同步。');
        } else {
          const syncStatus = runNode(helperPath, ['sync', row.id], { label: 'provider-manage.mjs' });
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
      }
      success('配置已更新。');
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

  const detailRows = await mapWithConcurrency(rows, Math.min(5, rows.length), async (row) => {
    const provider = cfg.models?.providers?.[row.id];
    const status = await detectProviderStatus(provider);
    return { row, provider, status };
  });

  const lines = detailRows.map(({ row, status }, i) => {
    const name = formatProviderRow(row);
    const url = maskUrl(row.baseUrl);
    const modelText = color(`${row.models}个模型`, C.yellow, C.bold);
    const providerStatusText = formatProviderStatusForProviderList(status);
    const currentTag = row.isPrimary ? ` | ${color('[默认]', C.yellow, C.bold)}` : '';
    return renderNumberedLine(i + 1, `${name} | ${url}`, `${modelText} | ${providerStatusText}${currentTag}`, { rawNote: true });
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
    if (exists && isModelAllowedByPolicy(cfg, item.ref)) {
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
      const note = `${formatProviderStatusForProviderList(providerStatus, { showError: false })} | ${formatModelCheckResultColored(modelStatus)}${item.ref === currentRef ? ` | ${color('[默认]', C.yellow, C.bold)}` : ''}`;
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
      const patchRes = applyConfigPatch({
        agents: { defaults: { model: { primary: selected.ref } } },
      });
      if (patchRes.status !== 0) {
        danger('写入默认模型配置失败。');
        if (patchRes.stdout) console.log(String(patchRes.stdout).trim());
        if (patchRes.stderr) console.log(String(patchRes.stderr).trim());
        await backPrompt(ask);
        continue;
      }
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
      const ref = `${providerId}/${model.id}`;
      if (!isModelAllowedByPolicy(cfg, ref)) continue;
      allModels.push({
        providerId,
        providerDisplayName,
        id: model.id,
        name: model.name || model.id,
        ref,
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
        const patchRes = applyConfigPatch({
          agents: { defaults: { model: { primary: selected.ref } } },
        });
        if (patchRes.status !== 0) {
          danger('写入默认模型配置失败。');
          if (patchRes.stdout) console.log(String(patchRes.stdout).trim());
          if (patchRes.stderr) console.log(String(patchRes.stderr).trim());
          await backPrompt(ask);
          return;
        }
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
    const value = String(res.stdout || '').trim();
    if (res.status === 0 && /^\d{4}\.\d+\.\d+$/.test(value)) {
      menuRuntimeCache.latestVersion = { value, ts: Date.now() };
      return value;
    }
    menuRuntimeCache.latestVersion = { value: '未知', ts: Date.now() };
    return '未知';
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
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = []; }
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
  const currentRunning = /Runtime:\s*running/i.test(statusText);
  const currentListening = /Listening:/i.test(statusText);
  const currentProbeOk = /Connectivity probe:\s*(ok|ready|passed|success)/i.test(statusText);

  if (currentRunning && (currentProbeOk || currentListening)) {
    return {
      title: 'Gateway 基本正常',
      summary: '当前 Gateway 正在运行且端口/探针正常;旧日志中的重启片段可忽略。',
      suggestion: '如功能正常,可继续使用;如仍有个别异常,再看日志细节。',
    };
  }

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


function compareReleaseVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => Number(x || 0));
  const pb = String(b || '').split('.').map((x) => Number(x || 0));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getConfigWrittenVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const value = raw?.meta?.writtenByVersion || raw?.meta?.configWrittenByVersion || raw?.meta?.lastWrittenByVersion || '';
    return extractOpenClawVersion(value, String(value || '').trim());
  } catch {
    return '';
  }
}

function runDestructiveOpenClaw(args, options = {}) {
  return runCommand('openclaw', args, { ...options, env: { ...process.env, OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: '1' } });
}

function setDowngradeConfigTouchedVersion(targetVersion) {
  const normalized = extractOpenClawVersion(targetVersion, String(targetVersion || '').trim());
  if (!/^\d{4}\.\d+\.\d+$/.test(normalized)) {
    return { ok: false, reason: '目标版本格式无效' };
  }
  const touchedAt = new Date().toISOString();
  // 路径 1:优先调用 OpenClaw CLI(config patch),官方支持的写入方式,保留 JSON5 注释/格式与文件权限。
  try {
    const patchRes = runCommand('openclaw', ['config', 'patch', '--stdin'], {
      input: JSON.stringify({ meta: { lastTouchedVersion: normalized, lastTouchedAt: touchedAt } }),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (patchRes.status === 0) {
      return { ok: true, version: normalized, via: 'cli' };
    }
  } catch {
    // 落到路径 2
  }
  // 路径 2:CLI 不可用时直接写文件;只做定向文本替换,保留剩余 JSON5 内容、文件权限与属主,绝不整体重写。
  try {
    const raw = fs.readFileSync(CONFIG, 'utf8');
    const stat = fs.statSync(CONFIG);
    const hasMeta = /(^|[\s,])meta\s*:/.test(raw);
    let next;
    if (hasMeta) {
      next = raw
        .replace(/(lastTouchedVersion\s*:\s*)("[^"]*"|'[^']*'|\d+)/, `$1"${normalized}"`)
        .replace(/(lastTouchedAt\s*:\s*)("[^"]*"|'[^']*')/, `$1"${touchedAt}"`);
      if (next === raw) {
        // 有 meta 但缺字段:回退到 JSON 解析补全(仍保留权限)。
        const cfg = JSON.parse(raw);
        cfg.meta = cfg.meta && typeof cfg.meta === 'object' && !Array.isArray(cfg.meta) ? cfg.meta : {};
        cfg.meta.lastTouchedVersion = normalized;
        cfg.meta.lastTouchedAt = touchedAt;
        next = `${JSON.stringify(cfg, null, 2)}\n`;
      }
    } else {
      const cfg = JSON.parse(raw);
      cfg.meta = { lastTouchedVersion: normalized, lastTouchedAt: touchedAt };
      next = `${JSON.stringify(cfg, null, 2)}\n`;
    }
    const tmp = `${CONFIG}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.chmodSync(tmp, stat.mode & 0o7777); // 保留原权限
    try { fs.chownSync(tmp, stat.uid, stat.gid); } catch { /* 非 root 或跨用户时忽略 */ }
    fs.renameSync(tmp, CONFIG);
    return { ok: true, version: normalized, via: 'manual' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function getSystemdUserGatewayServicePaths() {
  const userSystemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const serviceName = 'openclaw-gateway.service';
  const servicePath = path.join(userSystemdDir, serviceName);
  const dropInDir = path.join(userSystemdDir, `${serviceName}.d`);
  const downgradeDropInPath = path.join(dropInDir, '99-openclaw-api-menu-downgrade-recovery.conf');
  return { userSystemdDir, serviceName, servicePath, dropInDir, downgradeDropInPath };
}

function runSystemdUser(args, options = {}) {
  if (process.platform === 'win32') return { ok: false, skipped: true, reason: 'Windows 无 systemd user manager' };
  const res = runCommand('systemctl', ['--user', ...args], { timeout: 8000, ...options });
  return { ok: res.status === 0, status: res.status, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

function setSystemdUserDowngradeServiceEnv(enabled) {
  if (process.platform === 'win32') return { ok: false, skipped: true, reason: 'Windows 无 systemd user manager' };
  const { dropInDir, downgradeDropInPath } = getSystemdUserGatewayServicePaths();
  try {
    if (enabled) {
      fs.mkdirSync(dropInDir, { recursive: true });
      fs.writeFileSync(
        downgradeDropInPath,
        `[Service]\nEnvironment=OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\n`,
        'utf8',
      );
    } else {
      fs.rmSync(downgradeDropInPath, { force: true });
      try {
        fs.rmdirSync(dropInDir);
      } catch {
        // 目录里可能还有用户自己的 drop-in,保留即可。
      }
    }
  } catch (err) {
    return { ok: false, status: null, output: err.message };
  }
  const reloadRes = runSystemdUser(['daemon-reload']);
  return { ...reloadRes, path: downgradeDropInPath };
}

function cleanupSystemdUserGatewayService() {
  const result = { ok: true, steps: [] };
  const isMissingUnitOutput = (output) => /not loaded|not-found|could not be found|does not exist|No such file/i.test(String(output || ''));
  const pushStep = (name, res, options = {}) => {
    const tolerated = Boolean(options.tolerateMissing && !res.ok && isMissingUnitOutput(res.output));
    result.steps.push({ name, ...res, tolerated });
    if (!res.ok && !res.skipped && !tolerated) result.ok = false;
  };
  if (process.platform === 'win32') {
    result.ok = false;
    result.skipped = true;
    result.reason = 'Windows 无 systemd user manager';
    return result;
  }
  const { serviceName, servicePath, dropInDir } = getSystemdUserGatewayServicePaths();
  pushStep('stop', runSystemdUser(['stop', serviceName]), { tolerateMissing: true });
  pushStep('disable', runSystemdUser(['disable', serviceName]), { tolerateMissing: true });
  try {
    fs.rmSync(servicePath, { force: true });
    fs.rmSync(dropInDir, { recursive: true, force: true });
    result.steps.push({ name: 'remove-service-file', ok: true, path: servicePath });
  } catch (err) {
    result.ok = false;
    result.steps.push({ name: 'remove-service-file', ok: false, output: err.message, path: servicePath });
    warn(`清理 systemd service 文件失败: ${err.message}`);
  }
  pushStep('daemon-reload', runSystemdUser(['daemon-reload']));
  pushStep('reset-failed', runSystemdUser(['reset-failed', serviceName]), { tolerateMissing: true });
  return result;
}

async function installSpecificOpenClawVersion(ask) {
  renderScreenTitle('安装 / 回退指定 OpenClaw 版本');
  const currentVersionFull = getOpenClawVersion();
  const currentVersion = extractOpenClawVersion(currentVersionFull, currentVersionFull);
  console.log(`当前版本：${color(currentVersionFull, C.yellow, C.bold)}`);
  console.log('');
  warn('该功能适用于安装指定版本,或在新版本回归时临时回退。');
  info('升级时通常无需先停 Gateway；降级时脚本会先停止 Gateway,再安装旧版本并按需用恢复模式重新启动。');

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

  const isDowngrade = currentVersion !== '未知版本' && compareReleaseVersions(targetVersion, currentVersion) < 0;
  console.log('');
  if (targetVersion === currentVersion) {
    warn(`你选择的 ${targetVersion} 与当前版本一致。`);
  } else if (isDowngrade) {
    warn(`将回退到旧版本: openclaw@${targetVersion}`);
  } else {
    warn(`将安装指定版本: openclaw@${targetVersion}`);
  }
  const confirm = await ask(color('确认安装 / 回退到指定 OpenClaw 版本？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  const lines = [];
  if (isDowngrade) {
    info('检测到是降级操作,先停止 Gateway 以避免旧版本 binary 直接接管新配置。');
    const stopRes = runCommand('openclaw', ['gateway', 'stop'], { stdio: 'inherit' });
    if (stopRes.status === 0) {
      lines.push(color('Gateway 已停止。', C.green, C.bold));
    } else {
      lines.push(color('Gateway 停止失败;将继续尝试安装目标版本,但后续接管可能受影响。', C.yellow, C.bold));
    }
  }

  info(`正在安装 openclaw@${targetVersion}，请稍等...`);
  const installRes = runCommand('npm', ['install', '-g', `openclaw@${targetVersion}`], { stdio: 'inherit' });
  const newVersion = getOpenClawVersion();
  if (installRes.status !== 0) {
    await finishScreen(ask, [color('指定版本安装失败,请检查 npm、网络或版本号是否存在。', C.red, C.bold)]);
    return;
  }

  if (!String(newVersion).includes(targetVersion)) {
    lines.push(color(`安装流程已完成,但当前检测版本为:${newVersion}`, C.yellow, C.bold));
    lines.push(color('可能是当前命令路径未切换,或该版本未真正安装到当前正在使用的环境。', C.white));
  } else {
    lines.push(color(`指定版本安装完成。当前版本：${newVersion}`, C.green, C.bold));
  }

  const shouldUseRecovery = isDowngrade;
  let restartRes;
  if (shouldUseRecovery) {
    info('检测到是降级操作,将使用降级恢复模式重新安装 Gateway service 并重启。');
    const installServiceRes = runDestructiveOpenClaw(['gateway', 'install', '--force'], { stdio: 'inherit' });
    if (installServiceRes.status === 0) {
      lines.push(color('Gateway service 已由目标旧版本重新安装。', C.green, C.bold));
    } else {
      lines.push(color('Gateway service 重新安装失败;仍会继续尝试恢复模式重启。', C.yellow, C.bold));
    }
    const touchRes = setDowngradeConfigTouchedVersion(targetVersion);
    if (touchRes.ok) {
      lines.push(color(`配置写入版本已下调为 ${touchRes.version}。`, C.green, C.bold));
    } else {
      lines.push(color(`配置写入版本下调失败:${touchRes.reason}`, C.yellow, C.bold));
    }
    const envRes = setSystemdUserDowngradeServiceEnv(true);
    if (envRes.ok) {
      lines.push(color('已为 Gateway service 临时 drop-in 注入降级恢复环境变量。', C.green, C.bold));
    } else {
      lines.push(color('systemd service 临时环境变量注入失败;仍会继续尝试恢复模式重启。', C.yellow, C.bold));
    }
    try {
      restartRes = runDestructiveOpenClaw(['gateway', 'restart'], { stdio: 'inherit' });
    } finally {
      const cleanupEnvRes = setSystemdUserDowngradeServiceEnv(false);
      if (cleanupEnvRes.ok) {
        lines.push(color('已清理 Gateway service 临时降级恢复 drop-in。', C.green, C.bold));
      } else {
        lines.push(color('Gateway service 临时降级恢复 drop-in 清理失败,请检查 ~/.config/systemd/user/openclaw-gateway.service.d。', C.yellow, C.bold));
      }
    }
  } else {
    info('正在启动/重启 Gateway 并验证状态...');
    restartRes = runCommand('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
  }
  if (restartRes.status === 0) {
    lines.push(color('Gateway 启动/重启命令已执行完成。', C.green, C.bold));
    if (shouldUseRecovery) {
      lines.push(color('已使用降级恢复模式允许旧版本 binary 接管更高版本写入过的配置。', C.white));
      lines.push(color('如果仍提示旧版本保护,请执行 [19] 一键检查 Gateway 故障原因;重点检查 service 是否已指向目标版本。', C.white));
    }
  } else {
    lines.push(color('Gateway 启动/重启失败,请手动检查服务状态。', C.red, C.bold));
    if (shouldUseRecovery) {
      lines.push(color('如需手动执行,可在 ~/.config/systemd/user/openclaw-gateway.service.d/ 下临时添加 drop-in:', C.white));
      lines.push(color('[Service] Environment=OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1', C.white));
      lines.push(color('然后 systemctl --user daemon-reload,再执行 OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 openclaw gateway install --force && OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 openclaw gateway restart', C.white));
      lines.push(color('恢复后删除该 drop-in 并再次 systemctl --user daemon-reload。', C.white));
    }
  }
  await finishScreen(ask, lines);
}

async function backupOpenClaw(ask) {
  section('备份 OpenClaw 配置');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(os.homedir(), `openclaw-backup-${ts}.tar.gz`);
  info('正在备份配置，请稍等...');
  const res = spawnSync('tar', ['-czf', output, '-C', STATE_DIR, '.'], { stdio: 'inherit' });
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
  warn('会先停止并清理 Gateway systemd user service,避免卸载后残留坏服务。');
  const confirm = await ask(color('确认卸载 OpenClaw？(y/N): ', C.yellow, C.bold));
  if (confirm.toLowerCase() !== 'y') {
    info('操作已取消。');
    await backPrompt(ask);
    return;
  }
  info('正在停止并清理 Gateway systemd user service...');
  runCommand('openclaw', ['gateway', 'stop'], { stdio: 'inherit' });
  const systemdCleanup = cleanupSystemdUserGatewayService();
  if (systemdCleanup.skipped) {
    warn(`systemd service 清理已跳过:${systemdCleanup.reason}`);
  } else if (systemdCleanup.ok) {
    success('Gateway systemd user service 已 disable 并删除残留 service 文件。');
  } else {
    warn('Gateway systemd user service 清理未完全成功,后续仍会继续卸载。');
  }
  info('正在卸载 OpenClaw，请稍等...');
  const res = runCommand('npm', ['uninstall', '-g', 'openclaw'], { stdio: 'inherit' });
  if (res.status === 0) {
    success('OpenClaw 卸载成功。');
    info('本地配置和数据已保留,Gateway systemd user service 残留已尝试清理。');
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
  info('正在停止并清理 Gateway systemd user service...');
  runCommand('openclaw', ['gateway', 'stop'], { stdio: 'inherit' });
  const systemdCleanup = cleanupSystemdUserGatewayService();
  if (systemdCleanup.skipped) {
    warn(`systemd service 清理已跳过:${systemdCleanup.reason}`);
  } else if (systemdCleanup.ok) {
    success('Gateway systemd user service 已 disable 并删除残留 service 文件。');
  } else {
    warn('Gateway systemd user service 清理未完全成功,后续仍会继续卸载。');
  }
  info('正在卸载 OpenClaw，请稍等...');
  const uninstallRes = runCommand('npm', ['uninstall', '-g', 'openclaw'], { stdio: 'inherit' });
  // 失败保护:确认程序真的卸载成功才删配置,避免“程序还在、配置/Token/Session 全没了”。
  const stillInstalled = getOpenClawVersion() !== '';
  if (uninstallRes.status === 0 && !stillInstalled) {
    try {
      fs.rmSync(STATE_DIR, { recursive: true, force: true });
    } catch (err) {
      danger(`数据目录删除失败: ${err.message}`);
      await backPrompt(ask);
      return;
    }
    success('OpenClaw 已彻底卸载。');
    info('程序、本地配置、数据和 Gateway systemd user service 残留均已处理。');
    await backPrompt(ask);
    return;
  }
  // 卸载失败(或程序仍存在):不再自动删配置,改为询问用户。
  warn('OpenClaw 卸载失败或程序仍存在,默认不会删除配置/Token/Session。');
  if (stillInstalled) warn('检测到 openclaw 命令仍可用,程序本体可能未卸载干净。');
  const forceConfirm = await ask(color('卸载失败,是否仍然删除配置目录并继续？(y/N): ', C.red, C.bold));
  if (forceConfirm.toLowerCase() !== 'y') {
    info('已保留配置和数据,未删除任何文件。');
    await backPrompt(ask);
    return;
  }
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch (err) {
    danger(`数据目录删除失败: ${err.message}`);
    await backPrompt(ask);
    return;
  }
  warn('配置目录已强制删除,但程序卸载可能未完成,请手动检查 npm 卸载状态。');
  await backPrompt(ask);
}

async function repairHelperScripts(ask) {
  renderScreenTitle('检查 / 修复脚本依赖');
  const targetFiles = ['add-provider.mjs', 'provider-manage.mjs', 'list-providers-cn.mjs'];
  const missingScripts = targetFiles.filter((name) => !fs.existsSync(path.join(__dirname, name)));
  ensureJsonFile(DISPLAY_NAMES, {}, { label: 'provider-display-names.json', verbose: true });
  ensureJsonFile(RECENT_MODELS, [], { label: 'recent-models.json', verbose: true });
  const prunedDisplayNames = pruneDisplayNameMap({ verbose: false });
  const checkedCount = targetFiles.length + 2;
  const lines = [
    missingScripts.length
      ? color(`检测到缺少外部脚本:${missingScripts.join('、')}`, C.yellow, C.bold)
      : color('外部脚本完整,无需处理。', C.white),
    color(`检查摘要:共检查 ${checkedCount} 项,仅确认外部脚本是否存在,不再自动补齐脚本文件。`, C.white),
  ];
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
  if (!gateway.ok) lines.push(color('建议执行 [19] 一键检查 Gateway 故障原因。', C.yellow));
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
  console.log(menuItem(14, '降级 OpenClaw'));
  console.log(menuItem(15, '重启 Gateway'));
  console.log(menuItem(16, '备份 OpenClaw 配置'));
  console.log(menuItem(17, '卸载 OpenClaw'));
  console.log(menuItem(18, '彻底卸载 OpenClaw'));
  console.log(menuItem(19, '一键检查 Gateway 故障原因'));
  console.log(color('--------------------', C.gray));
  console.log(`20. 版本: ${color(currentMenuVersion, C.white, C.bold)}`);
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
      color(`版本: ${getCurrentMenuDisplayVersion()} | 更新: ${getCurrentMenuVersionInfo().updatedAt}`, C.gray),
      color('功能: 模型切换 / API 增删改 / 模型同步 / 系统升级重启 / 备份卸载', C.gray),
    ], C.cyan));
    console.log('');
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

  ensureOcapiShortcut({ verbose: true });
  pruneDisplayNameMap({ verbose: false });
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
