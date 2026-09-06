// 共享的模型上下文/输出上限推断 —— add-provider.mjs 与 provider-manage.mjs 都从这里取。
// 原则:
// 1) contextWindow 宁小勿大:虚标(给 128k 模型写 1M)会让 OpenClaw 压缩太晚,
//    撑到真实上限后上游硬报错、会话卡死(「Context is too large」事故)。
// 2) maxTokens 按家族官方输出上限;统一 128000 会被多数上游拒绝(5xx)。
// 3) 规则里没有的小众模型兜底 131072/32768;个别值不对可在 openclaw.json 手工改,
//    mergeModel 会保留手工字段(同步只重建脚本管理的字段)。
const NON_CHAT = /image|imagine|whisper|tts|embed|music|voice|audio|translate|riva|safety/;

const RULES = [
  [/\[1m\]/, 1048576, 32768],                         // 显式 1M 变体,如 deepseek-v4-flash[1m]
  [/gpt-6/, 400000, 128000],
  [/gpt-5\.6/, 1048576, 128000],                      // sol / luna / terra
  [/gpt-5/, 400000, 128000],                          // gpt-5.1 ~ 5.5 / 5.3-codex
  [/gpt-4\.1/, 1048576, 32768],
  [/\bo5\b/, 200000, 100000],
  [/claude/, 200000, 64000],
  [/gemini/, 1048576, 65536],
  [/grok-3-mini/, 131072, 32768],
  [/grok-4|grok-build|grok-composer/, 500000, 65536],
  [/minimax-m3/, 1048576, 32768],
  [/minimax-m2/, 204800, 32768],
  [/deepseek/, 128000, 32768],
  [/glm-5/, 200000, 65536],
  [/glm/, 131072, 32768],
  [/kimi/, 262144, 32768],
  [/qwen/, 262144, 32768],
  [/llama-4/, 1048576, 32768],
  [/llama/, 131072, 8192],
  [/gpt-oss/, 131072, 32768],
  [/command-a/, 262144, 32768],
  [/command-r/, 131072, 32768],
  [/mistral|codestral|devstral|ministral|magistral|voxtral/, 131072, 32768],
  [/hunyuan|hy3/, 262144, 32768],
  [/gemma|step-|nemotron|yi-|spark/, 131072, 32768],
];

export function guessModelLimits(id) {
  const s = String(id || '').toLowerCase();
  if (NON_CHAT.test(s)) return { contextWindow: 32768, maxTokens: 4096 };
  for (const [re, contextWindow, maxTokens] of RULES) {
    if (re.test(s)) return { contextWindow, maxTokens };
  }
  return { contextWindow: 131072, maxTokens: 32768 };
}
