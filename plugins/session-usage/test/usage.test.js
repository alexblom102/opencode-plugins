import assert from "node:assert/strict"
import test from "node:test"
import { UsageLedger, buildReport, estimateCost, formatReport, formatStatus, normalizeUsage, resolveRates } from "../usage.js"

const tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 1000, write: 50 }, total: 9999 }
function message(id = "m1", sessionID = "root", overrides = {}) {
  return {
    id, sessionID, role: "assistant", providerID: "test", modelID: "model", agent: "build",
    time: { created: 20, completed: 30 }, finish: "stop", cost: 0.12, tokens, ...overrides,
  }
}
function step(id = "s1", messageID = "m1", sessionID = "root", overrides = {}) {
  return { id, messageID, sessionID, type: "step-finish", cost: 0.12, tokens, ...overrides }
}
function ledger() {
  const result = new UsageLedger()
  result.session({ id: "root", title: "Test session", time: { created: 10 } })
  return result
}
const report = (value, opts) => buildReport(value, "root", opts)

test("all five billing token categories are counted once; provider total is not additive", () => {
  const value = ledger()
  value.observeMessage(message())
  const result = report(value)
  assert.deepEqual(result.tokens, { input: 100, output: 20, reasoning: 30, cacheRead: 1000, cacheWrite: 50, total: 1200 })
  assert.equal(result.requests, 1)
  assert.equal(result.recordedCost.usd, 0.12)
})

test("step usage supersedes message usage and repeated events/backfill are idempotent", () => {
  const value = ledger()
  const row = { info: message(undefined, undefined, { cost: 0.24 }), parts: [step(), step("s2")] }
  for (let n = 0; n < 4; n++) value.observeRow(row)
  const result = report(value)
  assert.equal(result.requests, 2)
  assert.equal(result.tokens.total, 2400)
  assert.equal(result.recordedCost.usd, 0.24)
  assert.equal(value.observeRow(row), false)
})

test("corrected step counters replace an earlier snapshot rather than add to it", () => {
  const value = ledger()
  value.observeMessage(message())
  value.observePart(step())
  value.observePart(step("s1", "m1", "root", { tokens: { ...tokens, output: 40 }, cost: 0.16 }))
  assert.equal(report(value).tokens.output, 40)
  assert.equal(report(value).recordedCost.usd, 0.16)
  assert.equal(report(value).requests, 1)
})

test("request history retained after removal, compaction, and persistence round-trip", () => {
  const value = ledger()
  value.observeRow({ info: message(), parts: [step()] })
  value.removeMessage("root", "m1")
  value.observeRow({ info: message("compact", "root", { summary: true, agent: "compaction" }), parts: [step("c1", "compact")] })
  value.session({ id: "root", deleted: true })
  const restored = new UsageLedger(JSON.parse(JSON.stringify(value.snapshot())))
  assert.equal(report(restored).tokens.total, 2400)
  assert.equal(report(restored).compactionRequests, 1)
  assert.equal(report(restored).calls.find((call) => call.messageID === "m1").removed, true)
  assert.equal(restored.sessions.get("root").deleted, true)
})

test("children and grandchildren are included but unrelated sessions are isolated", () => {
  const value = ledger()
  value.session({ id: "child", parentID: "root" })
  value.session({ id: "grandchild", parentID: "child" })
  value.observeMessage(message("r"))
  value.observeMessage(message("c", "child", { agent: "explore" }))
  value.observeMessage(message("g", "grandchild", { agent: "general" }))
  value.observeMessage(message("u", "unrelated"))
  assert.equal(report(value).requests, 3)
  assert.equal(report(value).sessions.length, 3)
  assert.equal(report(value, { includeChildren: false }).requests, 1)
  assert.deepEqual(new Set(report(value).agents.map((item) => item.name)), new Set(["build", "explore", "general"]))
})

test("copied fork history predates the new session and is not billed again", () => {
  const value = ledger()
  value.session({ id: "child", parentID: "root", time: { created: 100 } })
  value.observeMessage(message("copied", "child"))
  value.observeMessage(message("new", "child", { time: { created: 110, completed: 120 } }))
  const result = report(value)
  assert.equal(result.requests, 1)
  assert.equal(result.inheritedRequestsExcluded, 1)
})

test("pending, user, and shell messages do not become billed requests", () => {
  const value = ledger()
  value.observeMessage({ id: "user", sessionID: "root", role: "user", tokens })
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  value.observeMessage(message("pending", "root", { tokens: zero, cost: 0, time: { created: 20 }, finish: undefined }))
  value.observeMessage(message("shell", "root", { tokens: zero, cost: 0, finish: undefined }))
  assert.equal(report(value).requests, 0)
})

test("failed/interrupted calls with exposed usage remain counted and retries do not invent usage", () => {
  const value = ledger()
  value.observeMessage(message("failed", "root", { error: { name: "MessageAbortedError" }, finish: undefined }))
  const retry = { id: "retry1", messageID: "failed", sessionID: "root", type: "retry" }
  value.observePart(retry)
  value.observePart(retry)
  assert.equal(report(value).requests, 1)
  assert.equal(report(value).tokens.total, 1200)
  assert.equal(report(value).retryNotices, 1)
})

test("invalid/missing counters are unknown rather than free or negative", () => {
  const value = ledger()
  value.observeMessage(message("broken", "root", {
    tokens: { input: -10, output: NaN, reasoning: Infinity, cache: { read: 0, write: "20" } }, cost: NaN,
  }))
  const result = report(value)
  assert.equal(result.incompleteUsageRequests, 1)
  assert.equal(result.recordedCost.missingRequests, 1)
  assert.equal(result.rateCardCost.unpricedRequests, 1)
  assert.equal(result.tokens.total, 0)
  assert.deepEqual(normalizeUsage({}), { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cost: null })
})

test("rate-card billing includes reasoning at output rates and both cache categories", () => {
  const usage = normalizeUsage({ tokens, cost: 0 })
  const estimated = estimateCost(usage, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  assert.equal(estimated.complete, true)
  assert.ok(Math.abs(estimated.subtotal - 0.001025) < 1e-12)
  const separate = estimateCost(usage, { input: 2, output: 10, reasoning: 20, cacheRead: 0.2, cacheWrite: 2.5 })
  assert.ok(Math.abs(separate.subtotal - 0.001325) < 1e-12)
})

test("missing prices produce a known subtotal, and zero prices are supported explicitly", () => {
  const usage = normalizeUsage({ tokens })
  const partial = estimateCost(usage, { input: 2, output: 10 })
  assert.equal(partial.complete, false)
  assert.deepEqual(partial.missing, ["cacheRead", "cacheWrite"])
  assert.ok(Math.abs(partial.subtotal - 0.0007) < 1e-12)
  const free = estimateCost(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(free, { subtotal: 0, complete: true, missing: [] })
})

test("an overflowing rate cannot poison financial totals with Infinity", () => {
  const result = estimateCost(normalizeUsage({ tokens }), { input: Number.MAX_VALUE, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  assert.equal(Number.isFinite(result.subtotal), true)
  assert.equal(result.complete, false)
  assert.deepEqual(result.missing, ["input"])
})

test("rate lookup uses exact provider/model overrides and context-tier pricing", () => {
  const base = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }
  const high = { input: 4, output: 20, cache: { read: 0.4, write: 5 } }
  const providers = [{ id: "test", models: { model: { cost: { ...base, tiers: [{ ...high, tier: { type: "context", size: 200000 } }] } } } }]
  const usage = normalizeUsage({ tokens: { ...tokens, input: 200000 } })
  assert.equal(resolveRates(providers, "test", "model", usage).input, 4)
  assert.equal(resolveRates(providers, "other", "model", usage), undefined)
  assert.equal(resolveRates(providers, "test", "model", usage, { "test/model": { input: 9 } }).input, 9)
})

test("restoring persisted history preserves live corrections and recovers missing older steps", () => {
  const prior = ledger()
  prior.observeRow({ info: message(), parts: [step(), step("s2")] })
  const current = ledger()
  current.observeMessage(message())
  current.observePart(step("s2", "m1", "root", { tokens: { ...tokens, output: 40 } }))
  current.restore(prior.snapshot())
  assert.equal(report(current).requests, 2)
  assert.equal(report(current).tokens.output, 60)
})

test("exports contain accounting metadata, not prompts, tool output, credentials, or provider totals", () => {
  const value = ledger()
  value.observeRow({ info: message(undefined, undefined, { text: "PRIVATE PROMPT", apiKey: "SECRET" }), parts: [step(), { id: "text", type: "text", text: "PRIVATE TOOL OUTPUT" }] })
  const snapshot = JSON.stringify(value.snapshot())
  assert.equal(/PRIVATE|SECRET|9999/.test(snapshot), false)
  assert.equal(report(value).calls.length, 1)
})

test("API equivalent stays nonzero when ChatGPT Pro zeroes both usage cost and catalog prices", () => {
  const value = ledger()
  value.observeMessage(message(undefined, undefined, { cost: 0, providerID: "openai", modelID: "gpt-6.1-sol", variant: "max" }))
  const providers = [{ id: "openai", models: { "gpt-6.1-sol": { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } } }]
  const result = report(value, { providers, history: new Map([["root", "complete"]]) })
  assert.equal(result.recordedCost.usd, 0)
  assert.ok(Math.abs(result.rateCardCost.usd - 0.000925) < 1e-12)
  assert.equal(result.rateCardCost.unpricedRequests, 0)
  assert.equal(result.calls[0].estimate.rates.source, "published API prices")
  assert.equal(formatStatus(result), "Usage 1,200 | 5,000.0 tok/s | TTFT -- | API ~$0.000925")
  assert.match(formatReport(result), /API equivalent: ~\$0\.000925/)
  assert.equal(/invoice|disclaimer|Hidden|does not establish|refund/.test(formatReport(result)), false)
  assert.equal(result.coverage.historyComplete, true)
})

test("Sol Standard/Max rates apply through exactly 272,000 input tokens", () => {
  for (const input of [200_001, 250_000, 272_000]) {
    const usage = normalizeUsage({ tokens: { input, output: 100, reasoning: 50, cache: { read: 0, write: 0 } } })
    const rates = resolveRates([], "openai", "gpt-6.1-sol", usage)
    assert.equal(rates.input, 2)
    assert.equal(rates.output, 10)
    assert.equal(rates.cacheRead, 0.1)
    assert.equal(rates.cacheWrite, 2.5)
    assert.equal(rates.aboveInputTokens, undefined)
  }
})

test("272,001 input tokens reprice the full request, not just the excess", () => {
  const usage = normalizeUsage({ tokens: { input: 272_001, output: 100, reasoning: 50, cache: { read: 0, write: 0 } } })
  const rates = resolveRates([], "openai", "gpt-6.1-sol", usage)
  assert.equal(rates.input, 4)
  assert.equal(rates.output, 15)
  assert.equal(rates.cacheRead, 0.2)
  assert.equal(rates.cacheWrite, 5)
  assert.equal(rates.aboveInputTokens, 272000)
  assert.ok(Math.abs(estimateCost(usage, rates).subtotal - 1.090254) < 1e-12)
})

test("cached inputs and cache writes count towards long-context tier selection", () => {
  const usage = normalizeUsage({ tokens: { input: 1, output: 10, reasoning: 10, cache: { read: 271999, write: 1 } } })
  const rates = resolveRates([], "openai", "gpt-6.1-sol", usage)
  assert.equal(rates.inputTokens, 272001)
  assert.equal(rates.aboveInputTokens, 272000)
  assert.ok(Math.abs(estimateCost(usage, rates).subtotal - 0.0547088) < 1e-12)
})

test("context tiers are selected per request, not from cumulative session tokens", () => {
  const value = ledger()
  const overrides = { providerID: "openai", modelID: "gpt-6.1-sol", cost: 0,
    tokens: { input: 200000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  value.observeMessage(message("a", "root", overrides))
  value.observeMessage(message("b", "root", overrides))
  const result = report(value)
  assert.equal(result.tokens.input, 400000)
  assert.equal(result.longContextRequests, 0)
  assert.equal(result.rateCardCost.usd, 0.8)
})

test("precise catalog context tiers take precedence over a deprecated >200K fallback", () => {
  const base = { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }
  const high = { input: 4, output: 15, cache: { read: 0.2, write: 5 } }
  const providers = [{ id: "other", models: { model: { cost: { ...base,
    tiers: [{ ...high, tier: { type: "context", size: 272000 } }], experimentalOver200K: high } } } }]
  const usage = normalizeUsage({ tokens: { input: 250000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  assert.equal(resolveRates(providers, "other", "model", usage).input, 2)
})

test("configured tariffs can override both the base and long-context API prices", () => {
  const usage = normalizeUsage({ tokens: { input: 300000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } })
  const prices = { "openai/gpt-6.1-sol": { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5,
    tiers: [{ aboveInputTokens: 272000, input: 20, output: 30, cacheRead: 2, cacheWrite: 25 }] } }
  const rates = resolveRates([], "openai", "gpt-6.1-sol", usage, prices)
  assert.equal(rates.input, 20)
  assert.equal(rates.output, 30)
  assert.equal(rates.source, "configured")
})

test("unknown subscription-zeroed API rates display unpriced rather than $0", () => {
  const value = ledger()
  value.observeMessage(message(undefined, undefined, { cost: 0 }))
  const providers = [{ id: "test", models: { model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } } }]
  const result = report(value, { providers })
  assert.equal(result.rateCardCost.unpricedRequests, 1)
  assert.match(formatStatus(result), /API unpriced/)
})

test("primary display uses token-priced API equivalent even with a nonzero recorded cost", () => {
  const value = ledger()
  value.observeMessage(message(undefined, undefined, { cost: 999, providerID: "openai", modelID: "gpt-6.1-sol" }))
  const result = report(value)
  assert.match(formatStatus(result), /API ~\$0\.000925/)
  assert.equal(result.models[0].apiEquivalentCostUSD, result.rateCardCost.usd)
})
