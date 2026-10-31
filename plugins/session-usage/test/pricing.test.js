import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { catalogURL, createPriceCatalog, lookupCatalog, normalizeCost, parseCatalog, validCatalog } from "../pricing.js"
import { UsageLedger, buildReport, estimateCost, formatReport, normalizeUsage, resolveRates } from "../usage.js"
import { pricingFixture } from "./catalog-fixture.js"

const catalog = parseCatalog(pricingFixture, { fetchedAt: 100000 })
const usage = (input = 100, output = 20, reasoning = 30, read = 1000, write = 0) =>
  normalizeUsage({ tokens: { input, output, reasoning, cache: { read, write } }, cost: 0 })
const rates = (provider, model, tokens = usage(), options = {}) => resolveRates([], provider, model, tokens, {}, { catalog, ...options })

test("models.dev schema normalization preserves cache, reasoning and exact context thresholds", () => {
  const prices = normalizeCost(pricingFixture.openai.models["gpt-6.1-sol"].cost)
  assert.equal(prices.cacheRead, 0.1)
  assert.equal(prices.cacheWrite, 2.5)
  assert.deepEqual(prices.tiers.map((tier) => tier.aboveInputTokens), [272000])
  assert.equal(normalizeCost(pricingFixture.deepseek.models["deepseek-flash"].cost).reasoning, 0.6)
  assert.equal(normalizeCost({ input: -1, output: 10 }), undefined)
})

test("DeepSeek, GLM, Anthropic and Xiaomi use their own provider/model rate cards", () => {
  const checks = [
    ["deepseek", "deepseek-flash", 0.15, 0.6, 0.003, 0.000048],
    ["zai", "glm-5.3", 1.4, 4.4, 0.26, 0.00062],
    ["anthropic", "claude-opus-5-5", 4, 20, 0.2, 0.0016],
    ["xiaomi", "mimo-v2.6-pro", 0.435, 0.87, 0.0036, 0.0000906],
  ]
  for (const [provider, model, input, output, read, expected] of checks) {
    const selected = rates(provider, model)
    assert.equal(selected.input, input)
    assert.equal(selected.output, output)
    assert.equal(selected.cacheRead, read)
    assert.equal(selected.pricingProviderID, provider)
    assert.equal(selected.source, "models.dev")
    assert.ok(Math.abs(estimateCost(usage(), selected).subtotal - expected) < 1e-12)
  }
})

test("GLM coding plans map to their matching pay-as-you-go provider", () => {
  for (const [plan, api] of [["zai-coding-plan", "zai"], ["zhipuai-coding-plan", "zhipuai"]]) {
    const selected = rates(plan, "glm-5.3")
    assert.equal(selected.pricingProviderID, api)
    assert.equal(selected.input, 1.4)
    assert.equal(selected.output, 4.4)
  }
})

test("all three Xiaomi token-plan regions use Xiaomi's nonzero API prices", () => {
  for (const plan of ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"]) {
    const selected = rates(plan, "mimo-v2.6-pro")
    assert.equal(selected.pricingProviderID, "xiaomi")
    assert.equal(selected.input, 0.435)
    assert.equal(selected.cacheRead, 0.0036)
  }
})

test("Anthropic cache writes and model-specific 100K tiers are priced per request", () => {
  const below = rates("anthropic", "claude-haiku-5-5", usage(100000, 20, 30, 0, 0))
  const above = rates("anthropic", "claude-haiku-5-5", usage(100000, 20, 30, 0, 1))
  assert.equal(below.input, 0.1)
  assert.equal(above.aboveInputTokens, 100000)
  assert.equal(above.input, 0.5)
  assert.equal(above.output, 2.5)
  assert.equal(above.cacheWrite, 0.625)
  assert.ok(Math.abs(estimateCost(usage(100000, 20, 30, 0, 1), above).subtotal - 0.050125625) < 1e-12)
})

test("Vertex Anthropic tariffs remain separate from direct Anthropic tariffs", () => {
  const below = rates("google-vertex-anthropic", "claude-opus-4-8@default", usage(200000, 0, 0, 0, 0))
  const above = rates("google-vertex-anthropic", "claude-opus-4-8@default", usage(200001, 0, 0, 0, 0))
  assert.equal(below.input, 5)
  assert.equal(above.input, 10)
  assert.equal(above.output, 37.5)
  assert.equal(rates("anthropic", "claude-opus-4-8@default"), undefined)
})

test("router model IDs containing slashes use router prices, not vendor prices", () => {
  assert.equal(rates("router", "anthropic/claude-opus-5-5").input, 8)
  assert.equal(rates("anthropic", "claude-opus-5-5").input, 4)
  assert.equal(rates("unrelated", "claude-opus-5-5"), undefined)
})

test("known free API models retain zero prices without treating subscription plans as free", () => {
  const selected = rates("zhipuai", "glm-4.7-flash", usage(10, 10, 0, 0, 0))
  assert.equal(selected.input, 0)
  assert.equal(selected.output, 0)
  assert.deepEqual(estimateCost(usage(10, 10, 0, 0, 0), selected), { subtotal: 0, complete: true, missing: [] })
  assert.ok(rates("zhipuai-coding-plan", "glm-5.3").input > 0)
})

test("SDK API IDs resolve renamed local model IDs", () => {
  const providers = [{ id: "deepseek", models: { local: { api: { id: "deepseek-flash" } } } }]
  const selected = resolveRates(providers, "deepseek", "local", usage(), {}, { catalog })
  assert.equal(selected.pricingModelID, "deepseek-flash")
  assert.equal(selected.input, 0.15)
})

test("custom providers resolve by a unique API endpoint, not a similar model name", () => {
  const providers = [{ id: "my-glm", options: { baseURL: "https://api.z.ai/api/coding/paas/v4", apiKey: "PRIVATE" },
    models: { custom: { api: { id: "glm-5.3" } } } }]
  const selected = resolveRates(providers, "my-glm", "custom", usage(), {}, { catalog })
  assert.equal(selected.pricingProviderID, "zai")
  assert.equal(selected.input, 1.4)
  assert.equal(JSON.stringify(selected).includes("PRIVATE"), false)
  providers[0].options.baseURL = "https://api.z.ai.attacker.example/api/coding/paas/v4"
  assert.equal(resolveRates(providers, "my-glm", "custom", usage(), {}, { catalog }), undefined)
})

test("ambiguous endpoint providers stay unresolved until an alias is supplied", () => {
  const duplicate = parseCatalog({ ...pricingFixture, "deepseek-copy": pricingFixture.deepseek })
  const providers = [{ id: "local", models: { "deepseek-flash": { api: { url: "https://api.deepseek.com/v1" } } } }]
  assert.equal(resolveRates(providers, "local", "deepseek-flash", usage(), {}, { catalog: duplicate }), undefined)
  const selected = resolveRates(providers, "local", "deepseek-flash", usage(), {}, { catalog: duplicate, providerAliases: { local: "deepseek" } })
  assert.equal(selected.input, 0.15)
})

test("explicit provider/model aliases and price overrides take precedence", () => {
  assert.equal(rates("glm", "glm-5.3", usage(), { providerAliases: { glm: "zai" } }).input, 1.4)
  assert.equal(rates("custom", "renamed", usage(), { modelAliases: { "custom/renamed": "xiaomi/mimo-v2.6-pro" } }).input, 0.435)
  const selected = resolveRates([], "deepseek", "deepseek-flash", usage(), {
    "deepseek/deepseek-flash": { input: 9, output: 10, cacheRead: 1, cacheWrite: 0 },
  }, { catalog })
  assert.equal(selected.input, 9)
  assert.equal(selected.source, "configured")
})

test("a mixed-model session adds independently priced requests and exposes provider subtotals", () => {
  const ledger = new UsageLedger()
  const choices = [["deepseek", "deepseek-flash"], ["zai-coding-plan", "glm-5.3"], ["anthropic", "claude-opus-5-5"], ["xiaomi-token-plan-cn", "mimo-v2.6-pro"]]
  for (const [providerID, modelID] of choices) {
    const id = `message-${providerID}`
    ledger.observeMessage({ id, sessionID: "root", role: "assistant", providerID, modelID, agent: "build", finish: "stop",
      time: { created: 10, completed: 20 }, tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 1000, write: 0 } }, cost: 0 })
  }
  const result = buildReport(ledger, "root", { catalog })
  assert.equal(result.requests, 4)
  assert.equal(result.models.length, 4)
  assert.equal(result.providers.length, 4)
  assert.equal(result.rateCardCost.unpricedRequests, 0)
  assert.ok(Math.abs(result.rateCardCost.usd - 0.0023586) < 1e-12)
  assert.ok(Math.abs(result.providers.reduce((sum, item) => sum + item.apiEquivalentCostUSD, 0) - result.rateCardCost.usd) < 1e-12)
  assert.match(formatReport(result), /API rate card: zai\/glm-5\.3/)
  assert.match(formatReport(result), /API rate card: xiaomi\/mimo-v2\.6-pro/)
})

test("invalid and missing rate fields are not silently turned into free categories", () => {
  const malformed = parseCatalog({ provider: { models: {
    missing: { cost: { input: 1 } }, bad: { cost: { input: 1, output: -2 } },
    usable: { cost: { input: 1, output: 2 } },
  } } })
  assert.equal(malformed.modelCount, 1)
  const selected = resolveRates([], "provider", "usable", usage(), {}, { catalog: malformed })
  assert.equal(estimateCost(usage(), selected).complete, false)
  assert.equal(validCatalog({ ...catalog, source: "wrong" }), false)
  assert.throws(() => parseCatalog({}), /no token rate cards/)
})

async function workspace(t) {
  const root = await mkdtemp(path.join(process.env.OPENCODE_TEST_TMP ?? os.tmpdir(), "usage-pricing-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cachePath: path.join(root, "prices.json") }
}

const response = (data = pricingFixture) => new Response(JSON.stringify(data), { status: 200 })

test("price catalog fetches once, atomically caches data, and shares concurrent refreshes", async (t) => {
  const { root, cachePath } = await workspace(t)
  let fetches = 0
  const manager = createPriceCatalog({ cachePath, now: () => 200000, fetcher: async (url, options) => {
    fetches++
    assert.equal(url, catalogURL)
    assert.deepEqual(options.headers, { accept: "application/json" })
    await sleep(5)
    return response()
  } })
  await manager.start()
  assert.equal(fetches, 1)
  const cached = JSON.parse(await readFile(cachePath, "utf8"))
  assert.equal(validCatalog(cached), true)
  assert.equal(cached.fetchedAt, 200000)
  assert.deepEqual(await readdir(root), ["prices.json"])
  await Promise.all([manager.refresh(true), manager.refresh(true), manager.refresh(true)])
  assert.equal(fetches, 2)
})

test("a fresh cached price catalog is available offline with no network request", async (t) => {
  const { cachePath } = await workspace(t)
  await writeFile(cachePath, JSON.stringify(catalog))
  let fetches = 0
  const manager = createPriceCatalog({ cachePath, now: () => 100001, fetcher: async () => { fetches++; throw new Error("Offline") } })
  await manager.start()
  assert.equal(fetches, 0)
  assert.equal(manager.catalog.entries["xiaomi/mimo-v2.6-pro"].input, 0.435)
})

test("failed refreshes preserve stale cached prices and the existing cache file", async (t) => {
  const { cachePath } = await workspace(t)
  const original = JSON.stringify(catalog)
  await writeFile(cachePath, original)
  const manager = createPriceCatalog({ cachePath, now: () => 99999999, fetcher: async () => { throw new Error("Offline") } })
  await manager.start()
  assert.equal(manager.catalog.entries["deepseek/deepseek-flash"].input, 0.15)
  assert.equal(manager.lastError, "Offline")
  assert.equal(await readFile(cachePath, "utf8"), original)
})

test("corrupt caches are rebuilt, while invalid HTTP payloads do not replace good data", async (t) => {
  const { cachePath } = await workspace(t)
  await writeFile(cachePath, "not json")
  let bad = false
  const manager = createPriceCatalog({ cachePath, fetcher: async () => bad ? response({}) : response() })
  await manager.start()
  const good = await readFile(cachePath, "utf8")
  bad = true
  await manager.refresh(true)
  assert.equal(manager.catalog.modelCount, catalog.modelCount)
  assert.match(manager.lastError, /no token rate cards/)
  assert.equal(await readFile(cachePath, "utf8"), good)
})

test("HTTP errors and disposal end pending requests without inventing price data", async () => {
  const failed = createPriceCatalog({ fetcher: async () => new Response("failure", { status: 503 }) })
  await failed.start()
  assert.equal(failed.catalog, undefined)
  assert.match(failed.lastError, /HTTP 503/)
  let started
  const armed = new Promise((resolve) => { started = resolve })
  const manager = createPriceCatalog({ fetcher: async (_url, { signal }) => {
    started()
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted"))))
  } })
  const pending = manager.start()
  await armed
  manager.dispose()
  await pending
  assert.equal(manager.catalog, undefined)
})
