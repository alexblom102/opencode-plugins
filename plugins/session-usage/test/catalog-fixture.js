// Small models.dev-format fixtures. Vendor tariffs sampled on 2026-10-13;
// the synthetic router deliberately differs to test provider isolation.
export const pricingFixture = {
  openai: { name: "OpenAI", api: "https://api.openai.com/v1", models: {
    "gpt-6.1-sol": { name: "GPT-6.1 Sol", cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
      tiers: [{ input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: "context", size: 272000 } }],
      context_over_200k: { input: 4, output: 15, cache_read: 0.2, cache_write: 5 } } },
  } },
  deepseek: { name: "DeepSeek", api: "https://api.deepseek.com", models: {
    "deepseek-flash": { name: "DeepSeek V4.1 Flash", cost: { input: 0.15, output: 0.6, reasoning: 0.6, cache_read: 0.003 } },
  } },
  zai: { name: "Z.AI", api: "https://api.z.ai/api/paas/v4", models: {
    "glm-5.3": { name: "GLM-5.3", cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } },
  } },
  "zai-coding-plan": { name: "Z.AI Coding Plan", api: "https://api.z.ai/api/coding/paas/v4", models: {
    "glm-5.3": { name: "GLM-5.3", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  } },
  zhipuai: { name: "Zhipu AI", api: "https://open.bigmodel.cn/api/paas/v4", models: {
    "glm-5.3": { name: "GLM-5.3", cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } },
    "glm-4.7-flash": { name: "GLM-4.7-Flash", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  } },
  "zhipuai-coding-plan": { name: "Zhipu AI Coding Plan", api: "https://open.bigmodel.cn/api/coding/paas/v4", models: {
    "glm-5.3": { name: "GLM-5.3", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  } },
  anthropic: { name: "Anthropic", models: {
    "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
    "claude-haiku-5-5": { name: "Claude Haiku 5.5", cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125,
      tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: "context", size: 100000 } }] } },
  } },
  "google-vertex-anthropic": { name: "Vertex Anthropic", models: {
    "claude-opus-4-8@default": { name: "Claude Opus 4.8", cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25,
      tiers: [{ input: 10, output: 37.5, cache_read: 1, cache_write: 12.5, tier: { type: "context", size: 200000 } }] } },
  } },
  xiaomi: { name: "Xiaomi", api: "https://api.xiaomimimo.com/v1", models: {
    "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro", cost: { input: 0.435, output: 0.87, cache_read: 0.0036 } },
  } },
  "xiaomi-token-plan-cn": { name: "Xiaomi Token Plan China", api: "https://token-plan-cn.xiaomimimo.com/v1", models: {
    "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro", cost: { input: 0, output: 0, cache_read: 0 } },
  } },
  "xiaomi-token-plan-ams": { name: "Xiaomi Token Plan Europe", api: "https://token-plan-ams.xiaomimimo.com/v1", models: {
    "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro", cost: { input: 0, output: 0, cache_read: 0 } },
  } },
  "xiaomi-token-plan-sgp": { name: "Xiaomi Token Plan Singapore", api: "https://token-plan-sgp.xiaomimimo.com/v1", models: {
    "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro", cost: { input: 0, output: 0, cache_read: 0 } },
  } },
  router: { name: "Test router", api: "https://router.example/v1", models: {
    "anthropic/claude-opus-5-5": { name: "Claude Opus routed", cost: { input: 8, output: 40, cache_read: 0.4, cache_write: 10 } },
  } },
}
