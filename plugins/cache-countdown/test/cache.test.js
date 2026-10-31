import assert from "node:assert/strict"
import test from "node:test"
import { cachePolicy, countdown, describe, formatDuration, latestActivity, parseOptions } from "../cache.js"

const startedAt = 1_800_000_000_000
const options = parseOptions()
const tokens = (read = 0, write = 0) => ({ input: 100, output: 20, reasoning: 0, cache: { read, write } })
const message = (overrides = {}) => ({
  id: "message-1",
  role: "assistant",
  providerID: "openai",
  modelID: "gpt-6.1-sol",
  time: { created: startedAt, completed: startedAt + 120_000 },
  tokens: tokens(1000, 50),
  ...overrides,
})

test("GPT-6.1 and GPT-5.6+ use the current 30-minute policy", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6", "gpt-5.6", "gpt-5.10", "openai/gpt-6.1-sol"]) {
    assert.equal(cachePolicy("openai", model, options).ttlSeconds, 1800, model)
  }
  assert.equal(cachePolicy("openai", "gpt-5.5", options).ttlSeconds, 1800)
  assert.equal(cachePolicy("openai", "gpt-5.4", options).ttlSeconds, 300)
  assert.equal(cachePolicy("openai", "o3", options).ttlSeconds, 300)
})

test("Claude routed through Azure still has its default five-minute policy", () => {
  assert.equal(cachePolicy("azure", "claude-opus-4-6", options).ttlSeconds, 300)
  assert.equal(cachePolicy("proxy", "alias", options, "gpt-6.1-sol").ttlSeconds, 1800)
  assert.equal(cachePolicy("custom", "unknown-model", options).ttlSeconds, undefined)
})

test("display overrides have model, provider, fallback precedence", () => {
  const custom = parseOptions({
    ttlSeconds: 600,
    providerTtlSeconds: { anthropic: 3600 },
    modelTtlSeconds: { "anthropic/claude-sonnet-4-6": 300 },
  })
  assert.equal(cachePolicy("anthropic", "claude-sonnet-4-6", custom).ttlSeconds, 300)
  assert.equal(cachePolicy("anthropic", "claude-opus-4-6", custom).ttlSeconds, 3600)
  assert.equal(cachePolicy("custom", "unknown", custom).ttlSeconds, 600)
})

test("invalid TTL settings are rejected instead of creating NaN timers", () => {
  for (const ttlSeconds of [0, -1, 1.5, NaN, Infinity, "300", 86401]) {
    assert.throws(() => parseOptions({ ttlSeconds }), TypeError)
  }
  assert.throws(() => parseOptions({ providerTtlSeconds: [] }), TypeError)
  assert.throws(() => parseOptions({ modelTtlSeconds: { "x/y": "300" } }), TypeError)
  assert.equal(parseOptions({ warningSeconds: 0 }).warningSeconds, 0)
})

test("generation time consumes the window; completion and resume do not extend it", () => {
  const last = latestActivity([message()])
  const first = countdown(last, startedAt + 120_000, options)
  assert.equal(first.secondsLeft, 1680)
  assert.equal(first.label, "Cache ~28:00")
  const resumed = countdown(latestActivity([message()]), startedAt + 200_000, options)
  assert.equal(resumed.secondsLeft, 1600)
  assert.equal(resumed.expiresAt, first.expiresAt)
})

test("pending, failed usage-free, user, shell and summary messages do not refresh a cache", () => {
  const later = { time: { created: startedAt + 60_000 }, tokens: tokens(0, 0) }
  later.tokens.input = 0
  later.tokens.output = 0
  const messages = [
    message(),
    message({ ...later, id: "pending" }),
    message({ ...later, id: "failed", error: { name: "APIError" } }),
    message({ ...later, id: "shell", finish: "stop" }),
    message({ id: "user", role: "user", time: { created: startedAt + 90_000 } }),
    message({ id: "summary", summary: true, time: { created: startedAt + 100_000 } }),
  ]
  assert.equal(latestActivity(messages).messageID, "message-1")
})

test("new model requests refresh their own window, regardless of message array order", () => {
  const second = message({ id: "message-2", time: { created: startedAt + 240_000 }, tokens: tokens(800, 40) })
  const last = latestActivity([second, message()])
  assert.equal(last.messageID, "message-2")
  assert.equal(countdown(last, startedAt + 250_000, options).secondsLeft, 1790)
})

test("a cache write without a read starts the initial cache window", () => {
  const last = latestActivity([message({ tokens: tokens(0, 1000) })])
  assert.equal(countdown(last, startedAt, options).status, "active")
})

test("a zero-cache response displays no usage instead of a fresh active cache", () => {
  const last = latestActivity([message(), message({ id: "miss", time: { created: startedAt + 1000 }, tokens: tokens() })])
  assert.equal(countdown(last, startedAt + 1000, options).status, "uncached")
})

test("step-finish usage can arrive before the message aggregate and latest step wins", () => {
  const msg = message({ tokens: undefined })
  const last = latestActivity([msg], () => [
    { type: "step-finish", tokens: tokens(0, 1000) },
    { type: "tool", state: { status: "completed" } },
    { type: "step-finish", tokens: tokens(900, 20) },
  ])
  assert.equal(last.read, 900)
  assert.equal(last.write, 20)
})

test("expiry boundary is clamped and marked elapsed, without claiming eviction", () => {
  const last = latestActivity([message({ modelID: "claude-opus-4-6" })])
  assert.equal(countdown(last, startedAt + 299_001, options).label, "Cache ~00:01")
  for (const now of [startedAt + 300_000, startedAt + 400_000]) {
    const state = countdown(last, now, options)
    assert.equal(state.secondsLeft, 0)
    assert.equal(state.status, "elapsed")
    assert.equal(state.label, "Cache: TTL elapsed")
  }
})

test("warning starts only within the configured threshold", () => {
  const last = latestActivity([message()])
  assert.equal(countdown(last, startedAt + 1739_000, options).color, "success")
  assert.equal(countdown(last, startedAt + 1740_000, options).color, "warning")
  assert.equal(countdown(last, startedAt + 1799_000, parseOptions({ warningSeconds: 0 })).color, "success")
})

test("waiting, unknown models and clock skew remain explicit", () => {
  assert.equal(countdown(undefined, startedAt, options).status, "waiting")
  assert.equal(latestActivity([message({ time: { created: NaN } })]), undefined)
  assert.equal(countdown(latestActivity([message({ modelID: "unknown" })]), startedAt, options).status, "unknown")
  assert.equal(countdown(latestActivity([message()]), startedAt - 60_000, options).status, "clock-skew")
})

test("session data is isolated and previous requests keep their recorded model policy", () => {
  const openai = latestActivity([message()])
  const claude = latestActivity([message({ providerID: "azure", modelID: "claude-sonnet-5" })])
  assert.equal(countdown(openai, startedAt, options).secondsLeft, 1800)
  assert.equal(countdown(claude, startedAt, options).secondsLeft, 300)
  assert.equal(countdown(latestActivity([]), startedAt, options).status, "waiting")
})

test("duration formatting handles subsecond rounding, hours and elapsed values", () => {
  assert.equal(formatDuration(0.01), "00:01")
  assert.equal(formatDuration(300), "05:00")
  assert.equal(formatDuration(3600), "1:00:00")
  assert.equal(formatDuration(-10), "00:00")
})

test("details identify the observed model and explain the estimate", () => {
  const last = latestActivity([message()])
  const details = describe(last, countdown(last, startedAt, options))
  assert.match(details, /openai\/gpt-6\.1-sol/)
  assert.match(details, /1,000 cached tokens read, 50 written/)
  assert.match(details, /30-minute minimum/)
  assert.match(details, /Estimate from request start/)
})
