import assert from "node:assert/strict"
import test from "node:test"
import { UsageLedger, buildReport, formatStatus } from "../usage.js"
import { createTracker } from "../tracker.js"

const tokens = { input: 10, output: 40, reasoning: 60, cache: { read: 0, write: 0 } }
function info(id = "m", overrides = {}) {
  return { id, sessionID: "root", role: "assistant", providerID: "test", modelID: "model", agent: "build",
    time: { created: 1000, completed: 11000 }, finish: "stop", tokens, cost: 0, ...overrides }
}
function part(id, type, start, messageID = "m", options = {}) {
  return { id, sessionID: "root", messageID, type, text: "content", time: { start }, ...options }
}
const report = (ledger) => buildReport(ledger, "root")

test("historical TTFT waits for answer text and includes preceding reasoning time", () => {
  const ledger = new UsageLedger()
  ledger.observeRow({ info: info(), parts: [part("reason", "reasoning", 1500), part("answer", "text", 9000)] })
  const result = report(ledger)
  assert.equal(result.performance.firstOutputLatencyMs.average, 500)
  assert.equal(result.performance.firstAnswerLatencyMs.average, 8000)
  assert.equal(result.latestAnswer.firstAnswerTimingSource, "stored-text-start")
  assert.match(formatStatus(result), /TTFT ~8\.0s/)
})

test("live TTFT freezes on the first answer delta, not reasoning or an empty text-start", () => {
  let now = 100000
  const tracker = createTracker({}, () => {}, { now: () => now })
  tracker.event({ type: "message.updated", properties: { info: info("m", { time: { created: 1000 }, finish: undefined, tokens: { ...tokens, input: 0, output: 0, reasoning: 0 } }) } })
  tracker.event({ type: "message.part.updated", properties: { part: part("reason", "reasoning", 1500, "m", { text: "" }) } })
  now = 102000
  tracker.event({ type: "message.part.delta", properties: { sessionID: "root", messageID: "m", partID: "reason", field: "text", delta: "thinking" } })
  assert.equal(report(tracker.ledger).latestAnswer.firstAnswerLatencyMs, null)
  tracker.event({ type: "message.part.updated", properties: { part: part("answer", "text", 8000, "m", { text: "" }) } })
  now = 107500
  tracker.event({ type: "message.part.delta", properties: { sessionID: "root", messageID: "m", partID: "answer", field: "text", delta: "Hi" } })
  let result = report(tracker.ledger)
  assert.equal(result.requests, 0)
  assert.equal(result.latestAnswer.firstAnswerLatencyMs, 7500)
  assert.equal(result.latestAnswer.firstAnswerTimingSource, "live-token")
  assert.match(formatStatus(result), /TTFT 7\.5s/)
  now = 109000
  tracker.event({ type: "message.part.delta", properties: { sessionID: "root", messageID: "m", partID: "answer", field: "text", delta: " again" } })
  tracker.event({ type: "message.part.updated", properties: { part: part("answer", "text", 8000) } })
  tracker.event({ type: "message.updated", properties: { info: info() } })
  result = report(tracker.ledger)
  assert.equal(result.performance.firstAnswerLatencyMs.average, 7500)
  assert.equal(result.latestAnswer.firstAnswerLatencyMs, 7500)
})

test("the footer uses the latest main-session response; child and compaction timings cannot replace it", () => {
  const ledger = new UsageLedger()
  ledger.session({ id: "child", parentID: "root" })
  ledger.observeRow({ info: info(), parts: [part("answer", "text", 9000)] })
  ledger.observeRow({ info: info("child-m", { sessionID: "child", time: { created: 20000, completed: 22000 } }),
    parts: [part("child-a", "text", 21000, "child-m", { sessionID: "child" })] })
  ledger.observeRow({ info: info("compact", { summary: true, time: { created: 30000, completed: 33000 } }),
    parts: [part("compact-a", "text", 31000, "compact")] })
  assert.equal(report(ledger).latestAnswer.messageID, "m")
  ledger.observeMessage(info("pending", { time: { created: 40000 }, finish: undefined, tokens: { ...tokens, output: 0, reasoning: 0, input: 0 } }))
  assert.equal(report(ledger).latestAnswer.messageID, "pending")
  assert.match(formatStatus(report(ledger)), /TTFT --/)
})

test("empty, ignored, synthetic, invalid and reasoning-only blocks do not count as answer tokens", () => {
  const ledger = new UsageLedger()
  ledger.observeRow({ info: info(), parts: [
    part("reason", "reasoning", 1500), part("empty", "text", 2000, "m", { text: "" }),
    part("ignored", "text", 3000, "m", { ignored: true }), part("synthetic", "text", 4000, "m", { synthetic: true }),
    part("early", "text", 500), part("late", "text", 12000),
  ] })
  assert.equal(report(ledger).latestAnswer.firstAnswerLatencyMs, null)
  assert.equal(ledger.observeAnswerReceipt("root", "m", "reason", 1000, 9000), false)
  assert.equal(ledger.observeAnswerReceipt("root", "m", "ignored", 1000, 9000), false)
  assert.equal(ledger.observeAnswerReceipt("root", "m", "synthetic", 1000, 9000), false)
  assert.equal(ledger.observeAnswerReceipt("root", "m", "empty", 9000, 1000), false)
})

test("first-answer receipts survive restarts and are retained after message removal", () => {
  const ledger = new UsageLedger()
  ledger.observeRow({ info: info(), parts: [part("answer", "text", 9000, "m", { text: "PRIVATE" })] })
  ledger.observeAnswerReceipt("root", "m", "answer", 50000, 57800)
  ledger.removeMessage("root", "m")
  const snapshot = JSON.parse(JSON.stringify(ledger.snapshot()))
  assert.equal(/PRIVATE|partKinds/.test(JSON.stringify(snapshot)), false)
  const restored = new UsageLedger(snapshot)
  assert.equal(report(restored).latestAnswer.firstAnswerLatencyMs, 7800)
  assert.match(formatStatus(report(restored)), /TTFT 7\.8s/)
  assert.equal(report(restored).responses[0].removed, true)
})

test("legacy untyped output starts cannot mistake thinking for answer text", () => {
  const ledger = new UsageLedger()
  ledger.observeRow({ info: info(), parts: [part("reason", "reasoning", 1500), part("answer", "text", 9000)] })
  const saved = ledger.snapshot()
  for (const output of saved.sessions[0].messages[0].outputStarts) delete output.type
  const restored = new UsageLedger(saved)
  assert.equal(report(restored).latestAnswer.firstAnswerLatencyMs, null)
  restored.observeRow({ info: info(), parts: [part("reason", "reasoning", 1500), part("answer", "text", 9000)] })
  assert.equal(report(restored).latestAnswer.firstAnswerLatencyMs, 8000)
})
