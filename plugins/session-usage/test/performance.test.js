import assert from "node:assert/strict"
import test from "node:test"
import { UsageLedger, buildReport, formatReport, formatStatus } from "../usage.js"
import { createTracker } from "../tracker.js"

function row(id, { sessionID = "root", created = 1000, completed = 3000, output = 40, reasoning = 60,
  providerID = "test", modelID = "model", parts = [] } = {}) {
  return {
    info: { id, sessionID, role: "assistant", providerID, modelID, agent: "build",
      time: { created, completed }, finish: "stop", cost: 0,
      tokens: { input: 10000, output, reasoning, cache: { read: 20000, write: 5000 } } },
    parts: parts.map((part) => ({ messageID: id, sessionID, ...part })),
  }
}
function report(rows, options) {
  const ledger = new UsageLedger()
  ledger.session({ id: "root" })
  for (const item of rows) ledger.observeRow(item)
  return buildReport(ledger, "root", options)
}

test("effective throughput counts only output plus reasoning, with millisecond timestamps", () => {
  const result = report([row("one")])
  assert.equal(result.tokens.total, 35100)
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.equal(result.responses[0].durationMs, 2000)
  assert.equal(result.responses[0].generatedTokens, 100)
  assert.equal(result.performance.latencyMs.average, 2000)
  assert.match(formatStatus(result), /50\.0 tok\/s \| TTFT --/)
  assert.match(formatReport(result), /Response latency: avg 2s \| median 2s \| p95 2s/)
})

test("session throughput is duration-weighted; latency statistics use response samples", () => {
  const result = report([
    row("short", { created: 1000, completed: 2000, output: 100, reasoning: 0 }),
    row("long", { created: 5000, completed: 14000, output: 90, reasoning: 0 }),
  ])
  assert.equal(result.performance.tokensPerSecond, 19)
  assert.deepEqual(result.performance.latencyMs, { samples: 2, average: 5000, median: 5000, p95: 9000, min: 1000, max: 9000 })
  assert.equal(result.performance.latest.messageID, "long")
  assert.equal(result.performance.throughput.average, 55)
})

test("p95 is the nearest-rank percentile and latest is chronological, not insertion order", () => {
  const rows = Array.from({ length: 20 }, (_, n) => row(`m-${n}`, { completed: 1000 + (n + 1) * 1000 }))
  const result = report(rows.reverse())
  assert.equal(result.performance.latencyMs.median, 10500)
  assert.equal(result.performance.latencyMs.p95, 19000)
  assert.equal(result.performance.latest.messageID, "m-19")
})

test("several usage steps share one latency sample and sum generated tokens once", () => {
  const item = row("multi", { parts: [
    { id: "s1", type: "step-finish", cost: 0, tokens: { input: 10, output: 30, reasoning: 10, cache: { read: 0, write: 0 } } },
    { id: "s2", type: "step-finish", cost: 0, tokens: { input: 20, output: 50, reasoning: 10, cache: { read: 0, write: 0 } } },
  ] })
  const ledger = new UsageLedger()
  for (let n = 0; n < 3; n++) ledger.observeRow(item)
  const result = buildReport(ledger, "root")
  assert.equal(result.requests, 2)
  assert.equal(result.performance.responses, 1)
  assert.equal(result.performance.latencyMs.samples, 1)
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.deepEqual(result.responses[0].usageIDs, ["s1", "s2"])
  assert.equal(ledger.observeRow(item), false)
})

test("first output is the earliest timed nonempty text/reasoning block in the response", () => {
  const result = report([row("first", { parts: [
    { id: "text", type: "text", text: "answer", time: { start: 2200, end: 2900 } },
    { id: "reason", type: "reasoning", text: "thinking", time: { start: 1300, end: 2000 } },
    { id: "empty", type: "text", text: "", time: { start: 1001 } },
    { id: "synthetic", type: "text", text: "injected", synthetic: true, time: { start: 1002 } },
    { id: "ignored", type: "text", text: "ignored", ignored: true, time: { start: 1003 } },
    { id: "before", type: "reasoning", text: "invalid", time: { start: 900 } },
    { id: "after", type: "text", text: "invalid", time: { start: 4000 } },
    { id: "tool", type: "tool", state: { time: { start: 1100, end: 2800 } } },
  ] })])
  assert.equal(result.responses[0].firstOutputAt, 1300)
  assert.equal(result.performance.firstOutputLatencyMs.average, 300)
  assert.equal(result.responses[0].durationMs, 2000)
  assert.match(formatReport(result), /First output latency: avg 300ms/)
})

test("pending, missing, zero, reversed and invalid timestamps never become zero/Infinite speeds", () => {
  const result = report([
    row("pending", { completed: null }), row("same", { completed: 1000 }),
    row("backwards", { completed: 900 }), row("missing", { created: null }),
    row("negative", { created: -1 }), row("string", { created: "1000" }),
    row("nan", { completed: NaN }), row("infinite", { completed: Infinity }),
  ])
  assert.equal(result.performance.responses, 8)
  assert.equal(result.performance.timedResponses, 0)
  assert.equal(result.performance.missingTimingResponses, 8)
  assert.equal(result.performance.tokensPerSecond, null)
  assert.equal(result.performance.latencyMs.average, null)
  assert.match(formatStatus(result), /-- tok\/s \| TTFT --/)
  assert.equal(/NaN|Infinity/.test(JSON.stringify(result)), false)
})

test("missing generated-token counters exclude throughput but retain measured latency", () => {
  const result = report([row("missing", { reasoning: null }), row("known")])
  assert.equal(result.performance.timedResponses, 2)
  assert.equal(result.performance.throughputResponses, 1)
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.equal(result.responses[0].generatedTokens, null)
  assert.equal(result.responses[0].tokensPerSecond, null)
})

test("measured zero-output and interrupted responses are included without inventing tokens", () => {
  const failed = row("failed", { output: 10, reasoning: 0 })
  failed.info.error = { name: "MessageAbortedError" }
  failed.info.finish = undefined
  const result = report([row("zero", { output: 0, reasoning: 0 }), failed])
  assert.equal(result.performance.timedResponses, 2)
  assert.equal(result.performance.throughputResponses, 2)
  assert.equal(result.responses[0].tokensPerSecond, 0)
  assert.equal(result.performance.tokensPerSecond, 2.5)
})

test("timing groups include recursive children, while forks and unrelated sessions are excluded", () => {
  const ledger = new UsageLedger()
  ledger.session({ id: "root" })
  ledger.session({ id: "child", parentID: "root", time: { created: 2000 } })
  ledger.session({ id: "grandchild", parentID: "child" })
  ledger.observeRow(row("root"))
  ledger.observeRow(row("copied", { sessionID: "child" }))
  ledger.observeRow(row("child", { sessionID: "child", providerID: "other", modelID: "fast", created: 4000, completed: 5000 }))
  ledger.observeRow(row("grandchild", { sessionID: "grandchild" }))
  ledger.observeRow(row("unrelated", { sessionID: "unrelated" }))
  const result = buildReport(ledger, "root")
  assert.equal(result.performance.responses, 3)
  assert.equal(result.performance.tokensPerSecond, 60)
  assert.equal(result.models.find((item) => item.name === "other/fast").performance.tokensPerSecond, 100)
  assert.equal(result.providers.find((item) => item.name === "test").performance.timedResponses, 2)
  assert.equal(result.agents[0].performance.timedResponses, 3)
  assert.equal(result.sessions.find((item) => item.sessionID === "child").performance.responses, 1)
  assert.equal(buildReport(ledger, "root", { includeChildren: false }).performance.responses, 1)
})

test("timing survives removal/restart and old v1 snapshots still restore", () => {
  const ledger = new UsageLedger()
  ledger.observeRow(row("persist", { parts: [
    { id: "text", type: "text", text: "PRIVATE OUTPUT", time: { start: 1400 } },
  ] }))
  ledger.removeMessage("root", "persist")
  const snapshot = JSON.parse(JSON.stringify(ledger.snapshot()))
  assert.equal(/PRIVATE/.test(JSON.stringify(snapshot)), false)
  const restored = new UsageLedger(snapshot)
  const result = buildReport(restored, "root")
  assert.equal(result.performance.tokensPerSecond, 50)
  assert.equal(result.performance.firstOutputLatencyMs.average, 400)
  assert.equal(result.responses[0].removed, true)
  delete snapshot.sessions[0].messages[0].outputStarts
  const legacy = buildReport(new UsageLedger(snapshot), "root")
  assert.equal(legacy.performance.tokensPerSecond, 50)
  assert.equal(legacy.performance.firstOutputLatencyMs.average, null)
})

test("restoring older timing cannot overwrite live corrections but can recover missing blocks", () => {
  const prior = new UsageLedger()
  prior.observeRow(row("corrected", { parts: [
    { id: "text", type: "text", text: "old", time: { start: 1100 } },
    { id: "other", type: "reasoning", text: "thinking", time: { start: 1500 } },
  ] }))
  const current = new UsageLedger()
  current.observeRow(row("corrected", { completed: 5000, parts: [
    { id: "text", type: "text", text: "new", time: { start: 1700 } },
  ] }))
  current.restore(prior.snapshot())
  const result = buildReport(current, "root")
  assert.equal(result.performance.latencyMs.average, 4000)
  assert.equal(result.responses[0].firstOutputAt, 1500)
})

test("a slow history response cannot overwrite newer live response or output timings", async () => {
  let settle
  const rows = new Promise((resolve) => { settle = resolve })
  const tracker = createTracker({ session: {
    async get() { return { data: { id: "root" } } },
    async messages() { return rows },
    async children() { return { data: [] } },
  } })
  const pending = tracker.refresh("root")
  const live = row("race", { completed: 5000, parts: [
    { id: "text", type: "text", text: "live", time: { start: 2000 } },
  ] })
  tracker.event({ type: "message.updated", properties: { info: live.info } })
  tracker.event({ type: "message.part.updated", properties: { part: live.parts[0] } })
  settle({ data: [row("race", { parts: [
    { id: "text", type: "text", text: "stale", time: { start: 1200 } },
  ] })] })
  await pending
  const result = buildReport(tracker.ledger, "root")
  assert.equal(result.performance.latencyMs.average, 4000)
  assert.equal(result.performance.firstOutputLatencyMs.average, 1000)
})

test("empty sessions expose unavailable performance values and no timing samples", () => {
  const result = report([])
  assert.equal(result.performance.tokensPerSecond, null)
  assert.equal(result.performance.latest, null)
  assert.equal(result.performance.responses, 0)
  assert.match(formatReport(result), /Timing samples: 0\/0 responses/)
})
