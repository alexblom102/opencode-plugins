import assert from "node:assert/strict"
import test from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import MessageTimestamps from "../server.js"
import { createHooks } from "../timestamps.js"

process.env.TZ = "Etc/UTC"
const created = Date.UTC(2026, 9, 18, 15, 23, 5)
const completed = created + 37_000
const asked = "[Asked: 2026-10-18 15:23:05 UTC+00:00]\n\n"
const answered = "[Answered: 2026-10-18 15:23:42 UTC+00:00]\n\n"

function message(overrides = {}) {
  return {
    id: "msg_answer", sessionID: "ses_test", role: "assistant", parentID: "msg_question",
    time: { created, completed }, finish: "stop", ...overrides,
  }
}

function text(value, overrides = {}) {
  return {
    id: "prt_text", sessionID: "ses_test", messageID: "msg_answer",
    type: "text", text: value, ...overrides,
  }
}

function question(parts = [text("My question")], time = created) {
  return { message: { id: "msg_question", role: "user", time: { created: time } }, parts }
}

function update(info) {
  return { event: { type: "message.updated", properties: { info } } }
}

function fixture(info = message(), parts = [text("Final answer")]) {
  const row = structuredClone({ info, parts })
  const calls = { reads: 0, updates: [], errors: [] }
  const sdk = {
    session: { async message() { calls.reads++; return { data: structuredClone(row) } } },
    part: {
      async update(input) {
        calls.updates.push(structuredClone(input))
        const index = row.parts.findIndex((part) => part.id === input.partID)
        row.parts[index] = structuredClone(input.part)
        return { data: input.part }
      },
    },
  }
  const hooks = createHooks(sdk, async (error) => { calls.errors.push(error) })
  return { row, calls, sdk, hooks }
}

test("questions receive their recorded sent time once, preserving other parts and metadata", async () => {
  const hooks = createHooks({})
  const synthetic = text("Internal context", { id: "prt_internal", synthetic: true })
  const file = { type: "file", id: "prt_image", filename: "image.png" }
  const output = question([synthetic, file, text("My question", { metadata: { existing: 42 } }), text("More text", { id: "prt_more" })])
  await hooks["chat.message"]({}, output)
  await hooks["chat.message"]({}, output)
  assert.equal(output.parts[2].text, asked + "My question")
  assert.equal(output.parts[2].metadata.existing, 42)
  assert.equal(output.parts[3].text, "More text")
  assert.equal(output.parts[0], synthetic)
  assert.equal(output.parts[1], file)
})

test("synthetic, ignored, file-only, compaction, and subtask prompts are skipped", async () => {
  const hooks = createHooks({})
  for (const parts of [
    [text("Internal", { synthetic: true })],
    [text("Ignored", { ignored: true })],
    [{ type: "file", id: "prt_image" }],
    [text("  ")],
    [text("Compact"), { type: "compaction" }],
    [text("Delegate"), { type: "subtask" }],
  ]) {
    const output = question(parts)
    const before = structuredClone(output)
    await hooks["chat.message"]({}, output)
    assert.deepEqual(output, before)
  }
})

test("missing or malformed question times are not replaced with the current time", async () => {
  const hooks = createHooks({})
  for (const time of [undefined, null, NaN, Infinity, 9e20, "2026-10-18"]) {
    const output = question([text("Question")])
    output.message.time.created = time
    await hooks["chat.message"]({}, output)
    assert.equal(output.parts[0].text, "Question")
  }
})

test("local offsets include fractional hours and daylight-saving changes", async () => {
  const hooks = createHooks({})
  try {
    process.env.TZ = "Asia/Kathmandu"
    const nepal = question()
    await hooks["chat.message"]({}, nepal)
    assert.equal(nepal.parts[0].text, "[Asked: 2026-10-18 21:08:05 UTC+05:45]\n\nMy question")
    process.env.TZ = "America/New_York"
    const summer = question()
    await hooks["chat.message"]({}, summer)
    assert.match(summer.parts[0].text, /^\[Asked: 2026-10-18 11:23:05 UTC-04:00\]/)
    const winter = question([text("Winter")], Date.UTC(2026, 0, 18, 15, 23, 5))
    await hooks["chat.message"]({}, winter)
    assert.match(winter.parts[0].text, /^\[Asked: 2026-01-18 10:23:05 UTC-05:00\]/)
  } finally {
    process.env.TZ = "Etc/UTC"
  }
})

test("only the last visible answer text is labeled, using completion rather than creation time", async () => {
  const parts = [
    text("Progress", { id: "prt_progress" }),
    { type: "reasoning", id: "prt_reasoning", text: "Thinking" },
    text("```js\nconsole.log('done')\n```", { id: "prt_final", metadata: { provider: { id: "original" } }, time: { start: created, end: completed - 200 } }),
    text("Hidden", { id: "prt_hidden", synthetic: true }),
    text("Ignored", { id: "prt_ignored", ignored: true }),
    { type: "step-finish", id: "prt_step", reason: "stop" },
  ]
  const { hooks, row, calls } = fixture(message(), parts)
  await hooks.event(update(row.info))
  assert.equal(calls.updates.length, 1)
  assert.equal(calls.updates[0].partID, "prt_final")
  assert.equal(row.parts[2].text, answered + parts[2].text)
  assert.deepEqual(row.parts[2].time, parts[2].time)
  assert.deepEqual(row.parts[2].metadata.provider, { id: "original" })
  assert.equal(row.parts[0].text, "Progress")
  assert.equal(row.parts[1].text, "Thinking")
})

test("streaming, tool steps, summaries, errors, and structured output never count as final answers", async () => {
  const { hooks, calls } = fixture()
  for (const info of [
    message({ role: "user" }),
    message({ time: { created } }),
    message({ time: { created, completed: NaN } }),
    message({ finish: undefined }),
    message({ finish: "tool-calls" }),
    message({ finish: "unknown" }),
    message({ finish: "error" }),
    message({ summary: true }),
    message({ error: { name: "MessageAbortedError" } }),
    message({ error: { name: "APIError" } }),
    message({ structured: { result: "done" } }),
  ]) await hooks.event(update(info))
  await hooks.event({ event: { type: "message.part.updated", properties: { part: text("Streaming") } } })
  assert.equal(calls.reads, 0)
  assert.equal(calls.updates.length, 0)
})

test("a provider's stop finish reason does not turn a client tool step into a final answer", async () => {
  const { hooks, row, calls } = fixture(message(), [text("Working"), { type: "tool", id: "prt_tool", tool: "read" }])
  await hooks.event(update(row.info))
  assert.equal(calls.updates.length, 0)
})

test("provider-executed tools do not hide the final answer", async () => {
  const { hooks, row, calls } = fixture(message(), [
    { type: "tool", id: "prt_search", metadata: { providerExecuted: true } },
    text("Final answer"),
  ])
  await hooks.event(update(row.info))
  assert.equal(calls.updates.length, 1)
})

test("no text means no invented assistant response", async () => {
  const { hooks, row, calls } = fixture(message(), [{ type: "reasoning", id: "prt_reasoning", text: "Thought" }])
  await hooks.event(update(row.info))
  assert.equal(calls.updates.length, 0)
})

test("concurrent and repeated completion events cannot duplicate timestamps", async () => {
  const { hooks, row, calls } = fixture()
  await Promise.all(Array.from({ length: 8 }, () => hooks.event(update(row.info))))
  assert.equal(calls.reads, 1)
  assert.equal(calls.updates.length, 1)
  await hooks.event(update(row.info))
  assert.equal(calls.updates.length, 1)
  assert.equal(row.parts[0].text, answered + "Final answer")
})

test("provider history keeps original question/answer text and provider metadata", async () => {
  const { hooks, row } = fixture(message(), [text("Final answer", { metadata: { openai: { itemId: "item_1" } } })])
  const user = question()
  await hooks["chat.message"]({}, user)
  await hooks.event(update(row.info))
  const savedUser = user.parts[0]
  const savedAnswer = row.parts[0]
  const output = { messages: [{ info: user.message, parts: user.parts }, { info: row.info, parts: row.parts }] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  assert.equal(output.messages[0].parts[0].text, "My question")
  assert.equal(output.messages[1].parts[0].text, "Final answer")
  assert.deepEqual(output.messages[1].parts[0].metadata, { openai: { itemId: "item_1" } })
  assert.equal(savedUser.text, asked + "My question")
  assert.equal(savedAnswer.text, answered + "Final answer")
})

test("failed writes are handled and a later completion event can retry", async () => {
  const { hooks, row, calls, sdk } = fixture()
  const originalUpdate = sdk.part.update
  sdk.part.update = async () => { throw new Error("Temporary write failure") }
  await hooks.event(update(row.info))
  assert.equal(calls.errors.length, 1)
  assert.equal(row.parts[0].text, "Final answer")
  sdk.part.update = originalUpdate
  await hooks.event(update(row.info))
  assert.equal(row.parts[0].text, answered + "Final answer")
})

test("shutdown stops new work and drains an in-flight read without writing after disposal", async () => {
  const { hooks, row, calls, sdk } = fixture()
  let release
  sdk.session.message = () => new Promise((resolve) => { release = () => resolve({ data: row }) })
  const event = hooks.event(update(row.info))
  const dispose = hooks.dispose()
  release()
  await Promise.all([event, dispose])
  await hooks.event(update(row.info))
  const user = question()
  await hooks["chat.message"]({}, user)
  assert.equal(calls.updates.length, 0)
  assert.equal(user.parts[0].text, "My question")
})

test("the actual SDK bridge preserves transport authentication, directory routing, and part update bodies", async () => {
  const requests = []
  const info = message()
  const client = createOpencodeClient({
    baseUrl: "http://127.0.0.1:4096",
    directory: "C:\\Project with spaces",
    headers: { Authorization: "Basic fixture" },
    async fetch(request) {
      requests.push({ method: request.method, url: new URL(request.url), headers: request.headers, body: request.method === "PATCH" ? await request.json() : undefined })
      if (request.method === "GET") return Response.json({ info, parts: [text("Final answer")] })
      return Response.json(requests.at(-1).body)
    },
  })
  const hooks = await MessageTimestamps({ client })
  await hooks.event(update(info))
  assert.deepEqual(requests.map((request) => request.method), ["GET", "PATCH"])
  assert.equal(requests[0].url.pathname, "/session/ses_test/message/msg_answer")
  assert.equal(requests[0].url.searchParams.get("directory"), "C:\\Project with spaces")
  assert.equal(requests[1].url.pathname, "/session/ses_test/message/msg_answer/part/prt_text")
  assert.equal(requests[1].body.text, answered + "Final answer")
  for (const request of requests) assert.equal(request.headers.get("authorization"), "Basic fixture")
})
