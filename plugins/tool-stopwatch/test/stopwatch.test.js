import assert from "node:assert/strict"
import { test } from "node:test"
import { createTracker, formatDuration, parseOptions, sessionTools, toolSummary, visibleTimers } from "../stopwatch.js"

const options = parseOptions()
const tool = (id, status, start, end, name = "read") => ({ id, tool: name, status, start, end, summary: "" })

test("a restored running call uses its original start, not plugin startup", () => {
  const entries = createTracker().sync("s", [tool("a", "running", 1000)], 91_000)
  assert.equal(visibleTimers(entries, 91_000)[0].label, "1:30")
  assert.equal(visibleTimers(entries, 94_000)[0].label, "1:33")
})

test("parallel calls to the same tool have independent stopwatches", () => {
  const entries = createTracker().sync("s", [tool("a", "running", 0), tool("b", "running", 8000)], 10_000)
  assert.deepEqual(visibleTimers(entries, 12_000).map((row) => [row.id, row.label]), [["a", "0:12"], ["b", "0:04"]])
})

test("completion freezes at the server's end time and expires after five seconds", () => {
  const tracker = createTracker()
  tracker.sync("s", [tool("a", "running", 1000)], 1000)
  const entries = tracker.sync("s", [tool("a", "completed", 1000, 6000)], 7000)
  assert.equal(visibleTimers(entries, 9000)[0].label, "0:05")
  assert.equal(visibleTimers(entries, 10_999).length, 1)
  assert.equal(visibleTimers(entries, 11_000).length, 0)
})

test("errors and cancellations freeze using their recorded interval", () => {
  const entries = createTracker().sync("s", [tool("a", "error", 3000, 7500)], 8000)
  const row = visibleTimers(entries, 10_000)[0]
  assert.equal(row.status, "error")
  assert.equal(row.finished, true)
  assert.equal(row.elapsed, 4500)
})

test("pending arguments are not counted as tool execution", () => {
  const tracker = createTracker()
  assert.deepEqual(tracker.sync("s", [tool("a", "pending")], 1000), [])
  const entries = tracker.sync("s", [tool("a", "running", 5000)], 7000)
  assert.equal(visibleTimers(entries, 7000)[0].label, "0:02")
})

test("duplicate updates do not duplicate calls or reset timing", () => {
  const tracker = createTracker()
  const call = tool("a", "running", 1000)
  tracker.sync("s", [call], 2000)
  const entries = tracker.sync("s", [call, call], 6000)
  assert.equal(entries.length, 1)
  assert.equal(visibleTimers(entries, 6000)[0].label, "0:05")
})

test("old completed history does not reappear when reopening a session", () => {
  const entries = createTracker().sync("s", [tool("a", "completed", 1000, 2000)], 100_000)
  assert.deepEqual(visibleTimers(entries, 100_000), [])
})

test("deletion and switching sessions remove previous entries", () => {
  const tracker = createTracker()
  tracker.sync("one", [tool("a", "running", 0)], 1000)
  assert.deepEqual(tracker.sync("one", [], 2000), [])
  tracker.sync("one", [tool("a", "running", 0)], 3000)
  assert.deepEqual(tracker.sync("two", [], 4000), [])
})

test("missing running timestamps are explicitly approximate and stable", () => {
  const tracker = createTracker()
  tracker.sync("s", [tool("a", "running")], 1000)
  const entries = tracker.sync("s", [tool("a", "running")], 5000)
  assert.equal(visibleTimers(entries, 6000)[0].label, "~0:05")
  const corrected = tracker.sync("s", [tool("a", "running", 0)], 7000)
  assert.equal(visibleTimers(corrected, 7000)[0].label, "0:07")
})

test("a missing end time freezes at first observed completion", () => {
  const tracker = createTracker()
  tracker.sync("s", [tool("a", "running", 1000)], 2000)
  tracker.sync("s", [tool("a", "completed", 1000)], 6000)
  const entries = tracker.sync("s", [tool("a", "completed", 1000)], 8000)
  assert.equal(visibleTimers(entries, 9000)[0].label, "~0:05")
})

test("historical completions with no start show unknown instead of a false duration", () => {
  const entries = createTracker().sync("s", [tool("a", "completed", undefined, 6000)], 7000)
  assert.equal(visibleTimers(entries, 7000)[0].label, "—")
})

test("running calls are never capped by the completed-row limit", () => {
  const tools = [...Array.from({ length: 8 }, (_, i) => tool(`r${i}`, "running", 0)),
    ...Array.from({ length: 8 }, (_, i) => tool(`c${i}`, "completed", 0, 1000 + i))]
  const entries = createTracker().sync("s", tools, 2000)
  const rows = visibleTimers(entries, 2000, options)
  assert.equal(rows.filter((row) => !row.finished).length, 8)
  assert.deepEqual(rows.filter((row) => row.finished).map((row) => row.id), ["c7", "c6", "c5"])
  assert.equal(visibleTimers(entries, 2000, { ...options, keepCompletedSeconds: 0 }).length, 8)
})

test("duration formatting handles hours, invalid data and clock skew", () => {
  assert.equal(formatDuration(0), "0:00")
  assert.equal(formatDuration(59_999), "0:59")
  assert.equal(formatDuration(60_000), "1:00")
  assert.equal(formatDuration(3_661_000), "1:01:01")
  assert.equal(formatDuration(-1000), "0:00")
  for (const value of [NaN, Infinity, undefined, null]) assert.equal(formatDuration(value), "—")
  const entries = createTracker().sync("s", [tool("a", "running", 10_000)], 1000)
  assert.equal(visibleTimers(entries, 1000)[0].label, "0:00")
})

test("options default correctly and constrain refresh/retention settings", () => {
  assert.deepEqual(parseOptions(null), options)
  assert.deepEqual(parseOptions({ refreshMs: 1, keepCompletedSeconds: -1, maxCompleted: 2.9, showInputs: false }), {
    refreshMs: 250, keepCompletedSeconds: 0, maxCompleted: 2, showInputs: false,
  })
  assert.equal(parseOptions({ refreshMs: NaN }).refreshMs, 1000)
  assert.equal(parseOptions({ refreshMs: 999_999 }).refreshMs, 5000)
})

test("snapshots include assistant tool metadata only, respecting session isolation and undo", () => {
  const messages = [{ id: "u", role: "user" }, { id: "m1", role: "assistant" }, { id: "m2", role: "assistant" }]
  const parts = {
    u: [{ type: "text", text: "hello" }],
    m1: [
      { type: "text", text: "working" },
      { type: "tool", sessionID: "s", id: "p1", tool: "bash", state: {
        status: "running", input: { description: "Run tests" }, time: { start: 1000 }, output: "private tool output",
      } },
      { type: "tool", sessionID: "other", id: "p2", tool: "read", state: { status: "running" } },
    ],
    m2: [{ type: "tool", sessionID: "s", id: "p3", tool: "read", state: { status: "running", time: { start: 3000 } } }],
  }
  const state = { session: { messages: () => messages, get: () => ({ revert: { messageID: "m2" } }) }, part: (id) => parts[id] }
  assert.deepEqual(sessionTools(state, "s"), [{ id: "m1:p1", tool: "bash", status: "running", start: 1000, end: undefined, summary: "Run tests" }])
  assert.equal(sessionTools(state, "s", false)[0].summary, "")
  assert.deepEqual(sessionTools(state, undefined), [])
})

test("summaries cover built-in/MCP inputs without multiline or terminal controls", () => {
  assert.equal(toolSummary({ input: { filePath: "src/main.ts" } }), "src/main.ts")
  assert.equal(toolSummary({ title: "Inspect method", input: { class_name: "Example" } }), "Inspect method")
  assert.equal(toolSummary({ input: { command: "npm\ntest\x1b[31m" } }), "npm test")
  assert.equal(toolSummary({ input: { description: "😀".repeat(100) } }), "😀".repeat(80))
})
