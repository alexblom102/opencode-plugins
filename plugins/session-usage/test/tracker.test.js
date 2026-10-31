import assert from "node:assert/strict"
import test from "node:test"
import { createTracker } from "../tracker.js"
import { buildReport } from "../usage.js"

const usage = { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } }
function row(sessionID, output = 5) {
  return {
    info: { id: `m-${sessionID}`, sessionID, role: "assistant", providerID: "test", modelID: "test", agent: "build", time: { created: 100, completed: 200 }, tokens: { ...usage, output }, cost: 0.01, finish: "stop" },
    parts: [{ id: `s-${sessionID}`, messageID: `m-${sessionID}`, sessionID, type: "step-finish", tokens: { ...usage, output }, cost: 0.01 }],
  }
}

test("backfills all messages and recursive subagents with read-only SDK calls", async () => {
  const calls = []
  const parents = { child: "root", grandchild: "child" }
  const children = { root: ["child"], child: ["grandchild"], grandchild: [] }
  const client = { session: {
    async get({ sessionID }) { calls.push(["get", sessionID]); return { data: { id: sessionID, parentID: parents[sessionID], time: { created: 1 } } } },
    async messages(params) { assert.deepEqual(Object.keys(params), ["sessionID"]); calls.push(["messages", params.sessionID]); return { data: [row(params.sessionID)] } },
    async children({ sessionID }) { calls.push(["children", sessionID]); return { data: children[sessionID].map((id) => ({ id, parentID: sessionID })) } },
  } }
  const tracker = createTracker(client)
  await tracker.refresh("root")
  await tracker.refresh("root")
  const result = buildReport(tracker.ledger, "root", { history: tracker.history })
  assert.equal(result.requests, 3)
  assert.equal(result.tokens.total, 120)
  assert.equal(result.coverage.historyComplete, true)
  assert.equal(calls.length, 18)
})

test("API failures produce partial coverage while preserving already observed charges", async () => {
  const tracker = createTracker({ session: {
    async get() { throw new Error("Connection lost") },
    async messages() { return { data: [] } },
    async children() { return { data: [] } },
  } })
  tracker.event({ type: "message.updated", properties: { info: row("root").info } })
  await tracker.refresh("root")
  const result = buildReport(tracker.ledger, "root", { history: tracker.history })
  assert.equal(result.requests, 1)
  assert.equal(result.coverage.historyComplete, false)
  assert.equal(result.coverage.historyErrors[0].reason, "Connection lost")
})

test("a slow history response cannot overwrite a newer live usage event", async () => {
  let settle
  const rows = new Promise((resolve) => { settle = resolve })
  const tracker = createTracker({ session: {
    async get() { return { data: { id: "root", time: { created: 1 } } } },
    async messages() { return rows },
    async children() { return { data: [] } },
  } })
  const pending = tracker.refresh("root")
  tracker.event({ type: "message.updated", properties: { info: row("root", 50).info } })
  tracker.event({ type: "message.part.updated", properties: { part: row("root", 50).parts[0] } })
  settle({ data: [row("root", 5)] })
  await pending
  assert.equal(buildReport(tracker.ledger, "root").tokens.output, 50)
})

test("live part events before message metadata are reconciled without double counting", () => {
  const tracker = createTracker({})
  tracker.event({ type: "message.part.updated", properties: { part: row("root").parts[0] } })
  tracker.event({ type: "message.updated", properties: { info: row("root").info } })
  tracker.event({ type: "message.removed", properties: { sessionID: "root", messageID: "m-root" } })
  tracker.event({ type: "message.part.removed", properties: { sessionID: "root", partID: "s-root" } })
  const result = buildReport(tracker.ledger, "root")
  assert.equal(result.requests, 1)
  assert.equal(result.models[0].name, "test/test")
  assert.equal(result.calls[0].removed, true)
  assert.equal(result.tokens.total, 40)
})

test("concurrent history refreshes share one in-flight SDK request set", async () => {
  let reads = 0
  const client = { session: {
    async get() { reads++; return { data: { id: "root" } } },
    async messages() { reads++; return { data: [row("root")] } },
    async children() { reads++; return { data: [] } },
  } }
  const tracker = createTracker(client)
  await Promise.all([tracker.refresh("root"), tracker.refresh("root"), tracker.refresh("root")])
  assert.equal(reads, 3)
})
