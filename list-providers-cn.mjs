#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DISPLAY_NAMES = path.join(__dirname, 'provider-display-names.json');
const PROVIDER_STATUS_TIMEOUT_MS = 8000;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

const color = (s, ...styles) => styles.join('') + s + C.reset;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.min(Math.max(1, limit), items.length || 1);

  async function runOne() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, () => runOne()));
  return results;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function maskUrl(url) {
  if (!url || typeof url !== 'string') return '<none>';
  try {
    const u = new URL(url);
    const short = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '') || '/'}`;
    // 超过25个字符就截断
    return short.length > 25 ? `${short.slice(0, 22)}...` : short;
  } catch {
    return url.length > 25 ? `${url.slice(0, 22)}...` : url;
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
  if (!provider?.baseUrl || !provider?.apiKey) {
    return { online: false, latency: null, error: '未配置baseUrl或apiKey' };
  }
  const baseUrl = String(provider.baseUrl).replace(/\/+$/, '');
  const modelsUrl = /\/v1$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_STATUS_TIMEOUT_MS);
  const start = Date.now();
  try {
    // 改用GET请求,很多API不支持HEAD
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latency = Date.now() - start;
    return {
      online: res.ok,
      reachable: true,
      latency,
      httpStatus: res.status,
      state: res.ok ? 'available' : 'reachable_error',
      error: res.ok ? null : formatHttpStatusError(res.status),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      online: false,
      reachable: false,
      latency: null,
      state: 'offline',
      error: err.name === 'AbortError' ? '超时' : err.message,
    };
  }
}

const cfg = readJson(CONFIG, {});
const rawProviders = cfg.models?.providers || {};
const displayNames = readJson(DISPLAY_NAMES, {});
const modelConfig = cfg.agents?.defaults?.model;
const primary = (typeof modelConfig === 'string' ? modelConfig : modelConfig?.primary) || '<none>';
let primaryDisplay = primary;
if (primary !== '<none>' && primary.includes('/')) {
  const firstSlash = primary.indexOf('/');
  const providerId = primary.slice(0, firstSlash);
  const modelId = primary.slice(firstSlash + 1);
  const providerName = displayNames[providerId] || providerId;
  primaryDisplay = `${providerName} / ${modelId}`;
}

console.log(color(`OpenClaw API 提供商列表 (共 ${Object.keys(rawProviders).length} 个)`, C.bold));
console.log(color(`当前默认模型: ${primaryDisplay}`, C.dim));
console.log(color('──────────────────────────────────────────────────────────────────────────────────────────────────────', C.gray));

if (!Object.keys(rawProviders).length) {
  console.log(color('  暂无配置的API提供商', C.yellow));
  process.exit(0);
}

const rows = Object.entries(rawProviders).map(([id, provider]) => {
  const displayName = displayNames[id]
    || (Array.isArray(provider?.models) && typeof provider.models[0]?.name === 'string'
      ? String(provider.models[0].name).split('/')[0].trim()
      : id);
  return {
    id,
    displayName,
    provider,
    baseUrl: maskUrl(provider?.baseUrl),
    api: provider?.api || '<none>',
    models: Array.isArray(provider?.models) ? provider.models.length : 0,
    isPrimary: typeof primary === 'string' && primary.startsWith(`${id}/`),
  };
}).sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));

console.log(color('正在检测所有API状态，请稍等...', C.blue));
const statusMap = new Map();
await mapWithConcurrency(rows, 3, async (row) => {
  const status = await detectProviderStatus(row.provider);
  statusMap.set(row.id, status);
});

rows.forEach((row, idx) => {
  const status = statusMap.get(row.id) || {};
  const no = String(idx + 1);
  const primaryBadge = row.isPrimary ? color(' [默认]', C.yellow, C.bold) : '';
  const state = status.state || (status.online ? 'available' : status.reachable ? 'reachable_error' : 'offline');
  const statusDot = state === 'available' ? color('●', C.green) : state === 'reachable_error' ? color('●', C.yellow) : color('●', C.red);
  let latencyColor = C.green;
  if (status.latency >= 200 && status.latency < 500) latencyColor = C.yellow;
  else if (status.latency >= 500) latencyColor = C.magenta;
  const latencySuffix = status.latency ? ` ${color(`${status.latency}ms`, latencyColor)}` : '';
  const stateText = state === 'available'
    ? color(`在线${latencySuffix}`, C.green)
    : state === 'reachable_error'
      ? color(`在线但异常${latencySuffix}${status.error ? ` ${status.error}` : ''}`, C.yellow)
      : color(`离线/不可达${status.error ? ` ${status.error}` : ''}`, C.red);
  console.log(`${color(`[${no}]`, C.green, C.bold)} ${row.displayName} (${row.id})${primaryBadge} | API: ${color(row.baseUrl, C.white)} | 协议: ${color(row.api, C.white)} | 模型数量: ${color(String(row.models), C.yellow, C.bold)} | 状态: ${statusDot} ${stateText}`);
});
