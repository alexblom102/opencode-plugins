import assert from "node:assert/strict"
import test from "node:test"
import { UsageLedger, buildReport } from "../usage.js"

const tokens = { input: 100, output: 40, reasoning: 60, cache: { read: 0, write: 0 } }
function row(id = "m", completed = 10000, parts = []) {
  return { info: { id, sessionID: "root", role: "assistant", providerID: "test", modelID: "model", agent: "build",
    time: { created: 1000, completed }, finish: "stop", tokens, cost: 0 },
    parts: parts.map((part) => ({ id: part.id, sessionID: "root", messageID: id, ...part })) }
}
const text = (id, start, end, type = "text") => ({ id, type, text: "model output", time: { start, end } })
const tool = (id, start, end) => ({ id, type: "tool", state: { status: "completed", time: { start, end }, input: { secret: "PRIVATE" }, output: "PRIVATE" } })
function report(item) {
  const ledger = new UsageLedger()
  ledger.observeRow(item)
  return buildReport(ledger, "root")
}

test("a trailing tool's runtime does not affect reasoning + output tokens/sec", () => {
  for (const end of [7000, 31000, 120000]) {
    const result = report(row("m", end + 100, [text("r", 1100, 1500, "reasoning"), text("a", 1600, 2000), tool("t", 2000, end)]))
    assert.equal(result.responses[0].generatedTokens, 100)
    assert.equal(result.responses[0].modelDurationMs, 1000)
    assert.equal(result.performance.tokensPerSecond, 100)
    assert.equal(result.performance.toolDurationMs, end - 2000)
    assert.equal(result.performance.latencyMs.average, end + 100 - 1000)
  }
})

test("hidden thinking before answer text contributes to model time and generated tokens", () => {
  const result = report(row("m", 6200, [text("a", 5000, 6000)]))
  assert.equal(result.responses[0].firstAnswerLatencyMs, 4000)
  assert.equal(result.responses[0].modelDurationMs, 5000)
  assert.equal(result.performance.tokensPerSecond, 20)
})

test("model generation on both sides of a tool wait excludes the wait", () => {
  const result = report(row("m", 8100, [text("a1", 1100, 2000), tool("t", 2000, 7000), text("a2", 7500, 8000)]))
  assert.equal(result.responses[0].modelDurationMs, 2000)
  assert.equal(result.performance.tokensPerSecond, 50)
})

test("parallel tool intervals are merged instead of subtracted twice", () => {
  const result = report(row("m", 9100, [tool("a", 2000, 7000), tool("b", 2100, 8000), text("last", 8500, 9000)]))
  assert.equal(result.performance.toolDurationMs, 6000)
  assert.equal(result.responses[0].modelDurationMs, 2000)
  assert.equal(result.performance.tokensPerSecond, 50)
})

test("recorded generation concurrent with a tool is preserved", () => {
  const result = report(row("m", 10100, [tool("t", 2000, 10000), text("a", 4000, 6000)]))
  assert.equal(result.responses[0].modelDurationMs, 3000)
  assert.equal(result.performance.tokensPerSecond, 100000 / 3000)
})

test("tool-call-only output ends at invocation, before tool execution", () => {
  const result = report(row("m", 30100, [tool("t", 3000, 30000)]))
  assert.equal(result.responses[0].modelDurationMs, 2000)
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.equal(result.responses[0].firstAnswerLatencyMs, null)
})

test("unknown or invalid tool timings produce unknown speed while retaining response latency", () => {
  for (const part of [tool("t", undefined, undefined), tool("t", 3000, undefined), tool("t", 5000, 4000)]) {
    const result = report(row("m", 10000, [part]))
    assert.equal(result.performance.tokensPerSecond, null)
    assert.equal(result.performance.throughputResponses, 0)
    assert.equal(result.performance.latencyMs.average, 9000)
  }
})

test("tool timing is metadata-only, survives restarts and cannot be overwritten by stale history", () => {
  const ledger = new UsageLedger()
  const item = row("m", 8100, [text("answer", 1100, 2000), tool("t", 2000, 8000)])
  ledger.observeRow(item)
  const snapshot = JSON.parse(JSON.stringify(ledger.snapshot()))
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false)
  const restored = new UsageLedger(snapshot)
  assert.equal(buildReport(restored, "root").performance.tokensPerSecond, 100)
  const beforeRevision = ledger.revision
  ledger.observePart({ ...item.parts[1], state: { status: "completed", time: { start: 2500, end: 8000 } } })
  ledger.observeRow(item, beforeRevision)
  assert.equal(ledger.sessions.get("root").messages.get("m").toolTimes.get("t").startAt, 2500)
})

test("legacy snapshots are not treated as tool-free until retained parts are backfilled", () => {
  const ledger = new UsageLedger()
  const item = row("m", 10100, [text("answer", 1100, 2000), tool("t", 2000, 10000)])
  ledger.observeRow(item)
  const snapshot = ledger.snapshot()
  delete snapshot.sessions[0].messages[0].toolTimes
  delete snapshot.sessions[0].messages[0].timingKnown
  const restored = new UsageLedger(snapshot)
  assert.equal(buildReport(restored, "root").performance.tokensPerSecond, null)
  restored.observeRow(item)
  assert.equal(buildReport(restored, "root").performance.tokensPerSecond, 100)
})

test("session rate is weighted by model time, independent of response tool runtimes", () => {
  const ledger = new UsageLedger()
  ledger.observeRow(row("fast", 10100, [text("a", 1100, 2000), tool("t", 2000, 10000)]))
  ledger.observeRow(row("slow", 31100, [text("a", 1100, 4000), tool("t", 4000, 31000)]))
  const result = buildReport(ledger, "root")
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.equal(result.performance.modelDurationMs, 4000)
  assert.equal(result.models[0].performance.tokensPerSecond, 50)
  assert.equal(result.providers[0].performance.tokensPerSecond, 50)
})
