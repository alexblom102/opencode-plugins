import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createNotifier, postDiscord, readSettings } from "../notifier.mjs"
import { normalizeSettings, updateSettingsFile, watchSettings } from "../settings.mjs"
import { registerNotificationControls } from "../tui.js"

const webhookUrl = "https://discord.com/api/webhooks/123456789/test-token"

function fixture(settings = {}, info = {}, fetchOverride) {
  let clock = 0
  let tick
  const posts = []
  const logs = []
  const lookups = []
  const notifier = createNotifier({
    directory: "C:\\projects\\demo",
    client: {
      session: { get: async (args) => {
        lookups.push(args.path.id)
        return { data: { id: args.path.id, title: "Test task", ...info } }
      } },
      app: { log: async (entry) => logs.push(entry) },
    },
  }, { webhookUrl, heartbeatSeconds: 60, progressIntervalSeconds: 15, ...settings }, {
    now: () => clock,
    setInterval: (fn) => { tick = fn; return { unref() {} } },
    clearInterval: () => { tick = undefined },
    fetch: async (url, options) => {
      if (fetchOverride) return fetchOverride(url, options, posts)
      posts.push(JSON.parse(options.body))
      return new Response(null, { status: 204 })
    },
  })
  return {
    ...notifier, posts, logs, lookups,
    event: async (type, properties = {}) => notifier.hooks.event({
      event: { type, properties: { sessionID: "ses_test", ...properties } },
    }),
    advance: async (ms) => { clock += ms; tick?.(); await notifier.flush() },
    titles: () => posts.map((post) => post.embeds[0].title),
  }
}

test("coalesces compact progress, sends heartbeats, and deduplicates idle", async () => {
  const f = fixture({ readyMinMinutes: 0, events: { started: true, progress: true } })
  await f.event("session.status", { status: { type: "busy" } })
  await f.event("session.status", { status: { type: "busy" } })
  await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
  await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "b", tool: "read" })
  await f.hooks["tool.execute.after"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
  await f.event("todo.updated", { todos: [{ content: "Build feature", status: "in_progress" }] })
  await f.event("todo.updated", { todos: [{ content: "Build feature", status: "completed" }] })
  await f.advance(14000)
  assert.equal(f.posts.length, 1)
  await f.advance(1000)
  assert.equal(f.posts[1].embeds[0].description, "Task progress updated.")
  assert.doesNotMatch(JSON.stringify(f.posts[1]), /Build feature|Tasks:|Tools completed|Current tool/)
  await f.advance(59000)
  assert.equal(f.posts.length, 2)
  await f.advance(1000)
  assert.match(f.posts[2].embeds[0].description, /Still working/)
  await f.event("session.status", { status: { type: "idle" } })
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Started", "OpenCode - Progress", "OpenCode - Progress", "OpenCode - Response ready"])
  assert.deepEqual(f.lookups, ["ses_test"])
  await f.advance(60000)
  assert.equal(f.posts.length, 4)
  await f.hooks.dispose()
})

test("permission and question alerts wait for all replies before reporting response-ready", async () => {
  const f = fixture({ readyMinMinutes: 0 })
  await f.event("session.status", { status: { type: "busy" } })
  await f.event("permission.asked", { id: "perm1", permission: "bash" })
  await f.event("permission.asked", { id: "perm1", permission: "bash" })
  await f.event("question.v2.asked", { id: "q1", questions: [{ question: "Which branch?" }] })
  await f.event("session.idle")
  await f.advance(120000)
  assert.equal(f.posts.length, 2)
  assert.match(f.posts[1].embeds[0].description, /Which branch\?/)
  await f.event("permission.replied", { requestID: "perm1" })
  await f.event("session.idle")
  await f.flush()
  assert.equal(f.posts.length, 2)
  await f.event("question.v2.rejected", { requestID: "q1" })
  await f.event("session.idle")
  await f.flush()
  assert.equal(f.titles().at(-1), "OpenCode - Response ready")
  await f.hooks.dispose()
})

test("errors and cancellations never produce false response-ready notifications", async () => {
  const f = fixture()
  for (const name of ["ApiError", "MessageAbortedError"]) {
    await f.event("session.status", { status: { type: "busy" } })
    await f.event("session.error", { error: { name, data: { message: "private server response" } } })
    await f.event("session.idle")
  }
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Error", "OpenCode - Stopped"])
  assert.doesNotMatch(JSON.stringify(f.posts), /private server response/)
  await f.hooks.dispose()
})

test("child sessions are opt-in", async () => {
  for (const includeSubagents of [false, true]) {
    const f = fixture({ includeSubagents, readyMinMinutes: 0 }, { parentID: "ses_parent" })
    await f.event("session.status", { status: { type: "busy" } })
    await f.event("session.idle")
    await f.flush()
    assert.equal(f.posts.length, includeSubagents ? 1 : 0)
    await f.hooks.dispose()
  }
})

test("delivery failures do not break subsequent notifications or expose webhook credentials in logs", async () => {
  let calls = 0
  const f = fixture({ readyMinMinutes: 0, events: { started: true } }, {}, async (_url, options, posts) => {
    if (++calls === 1) throw new Error(`Cannot fetch ${webhookUrl}`)
    posts.push(JSON.parse(options.body))
    return new Response(null, { status: 204 })
  })
  await f.event("session.status", { status: { type: "busy" } })
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Response ready"])
  assert.equal(f.logs.length, 1)
  assert.doesNotMatch(JSON.stringify(f.logs), /test-token/)
  await f.hooks.dispose()
})

test("transport honors rate limits, disables mentions, and restricts credential delivery to Discord", async () => {
  let calls = 0
  const delays = []
  const runtime = {
    sleep: async (ms) => delays.push(ms),
    fetch: async (url, options) => {
      calls++
      assert.equal(new URL(url).hostname, "discord.com")
      assert.deepEqual(JSON.parse(options.body).allowed_mentions, { parse: [] })
      assert.equal(options.redirect, "error")
      assert.ok(options.signal instanceof AbortSignal)
      return calls === 1
        ? Response.json({ retry_after: 0.5 }, { status: 429 })
        : new Response(null, { status: 204 })
    },
  }
  await postDiscord(webhookUrl, { content: "@everyone", allowed_mentions: { parse: ["everyone"] } }, runtime)
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500])
  await assert.rejects(postDiscord("https://example.com/api/webhooks/123/token", {}, runtime))
  assert.equal(calls, 2)
  await assert.rejects(postDiscord(webhookUrl, {}, { fetch: async () => new Response(null, { status: 404 }) }), /HTTP 404/)
})

test("environment-only settings and disabling notifications work without a settings file", async () => {
  const settings = await readSettings(new URL("./missing-settings.fixture.json", import.meta.url), {
    OPENCODE_DISCORD_WEBHOOK_URL: webhookUrl,
  })
  assert.equal(settings.webhookUrl, webhookUrl)
  assert.equal(settings.heartbeatSeconds, 60)
  assert.equal(settings.readyMinMinutes, 5)
  const f = fixture({ enabled: false })
  await f.event("session.status", { status: { type: "busy" } })
  await f.event("session.idle")
  await f.flush()
  assert.equal(f.posts.length, 0)
  f.updateSettings({ webhookUrl, enabled: true })
  await f.event("session.status", { status: { type: "busy" } })
  await f.advance(5 * 60000 + 1)
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Response ready"])
  await f.hooks.dispose()
})

test("Started and Progress are off by default, including long sessions without a tool", async () => {
  const f = fixture()
  await f.event("session.status", { status: { type: "busy" } })
  await f.event("todo.updated", { todos: [{ content: "Working", status: "in_progress" }] })
  await f.advance(30 * 60000)
  assert.equal(f.posts.length, 0)
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Response ready"])
  await f.hooks.dispose()
})

test("response-ready sends only after more than five minutes, with no delayed alert for short responses", async () => {
  for (const elapsed of [0, 60000, 5 * 60000, 5 * 60000 + 1, 6 * 60000]) {
    const f = fixture()
    await f.event("session.status", { status: { type: "busy" } })
    await f.advance(elapsed)
    await f.event("session.status", { status: { type: "idle" } })
    await f.event("session.idle")
    await f.flush()
    const expected = elapsed > 5 * 60000 ? ["OpenCode - Response ready"] : []
    assert.deepEqual(f.titles(), expected, `${elapsed}ms`)
    await f.advance(10 * 60000)
    assert.deepEqual(f.titles(), expected, "A finished short response must never alert later")
    await f.hooks.dispose()
  }
})

test("the response-ready minimum uses each response's elapsed time rather than total session age", async () => {
  const f = fixture()
  for (let turn = 0; turn < 3; turn++) {
    await f.event("session.status", { status: { type: "busy" } })
    await f.advance(2 * 60000)
    await f.event("session.idle")
    await f.flush()
  }
  assert.equal(f.posts.length, 0)
  await f.event("session.status", { status: { type: "busy" } })
  await f.advance(6 * 60000)
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Response ready"])
  assert.equal(f.posts[0].embeds[0].fields.find((field) => field.name === "Elapsed").value, "6m 0s")
  await f.hooks.dispose()
})

test("live response-ready minimum changes apply to running responses and queued alerts", async () => {
  const f = fixture()
  await f.event("session.status", { status: { type: "busy" } })
  await f.advance(4 * 60000)
  f.updateSettings({ webhookUrl, readyMinMinutes: 3 })
  await f.event("session.idle")
  await f.flush()
  assert.equal(f.posts.length, 1)
  await f.event("session.status", { status: { type: "busy" } })
  await f.advance(6 * 60000)
  const idle = f.event("session.idle")
  f.updateSettings({ webhookUrl, readyMinMinutes: 10 })
  await idle
  await f.flush()
  assert.equal(f.posts.length, 1, "A queued notification must honor an increased minimum")
  await f.hooks.dispose()
})

test("a tool alerts only after exceeding 20 minutes and only once per call", async () => {
  const f = fixture()
  await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "long", tool: "bash" })
  await f.advance(20 * 60000 - 1)
  assert.equal(f.posts.length, 0)
  await f.advance(1)
  assert.equal(f.posts.length, 0)
  await f.advance(1)
  assert.deepEqual(f.titles(), ["OpenCode - Long-running tool"])
  assert.match(f.posts[0].embeds[0].description, /\*\*bash\*\*.*20m 0s/)
  await f.advance(40 * 60000)
  assert.equal(f.posts.length, 1)
  await f.hooks["tool.execute.after"]({ sessionID: "ses_test", callID: "long" })
  await f.event("session.idle")
  await f.flush()
  assert.equal(f.titles().at(-1), "OpenCode - Response ready")
  await f.hooks.dispose()
})

test("parallel tool calls have independent timers and streaming updates do not reset them", async () => {
  const f = fixture()
  const part = (callID, start, status = "running") => ({
    type: "tool", sessionID: "ses_test", callID, tool: "mcp_example", state: { status, time: { start } },
  })
  await f.event("message.part.updated", { part: part("a", 0) })
  await f.advance(10 * 60000)
  await f.event("message.part.updated", { part: part("b", 10 * 60000) })
  await f.event("message.part.updated", { part: part("a", 0) })
  await f.advance(10 * 60000 + 1)
  assert.equal(f.posts.length, 1)
  await f.event("message.part.updated", { part: part("a", 0) })
  await f.advance(10 * 60000)
  assert.equal(f.posts.length, 2)
  await f.hooks.dispose()
})

test("completed, failed, cancelled, and deleted tool calls do not produce stale alerts", async () => {
  for (const finish of ["after", "completed", "error", "cancel", "delete"]) {
    const f = fixture({ events: { ready: false, stopped: false } })
    await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
    await f.advance(5 * 60000)
    if (finish === "after") await f.hooks["tool.execute.after"]({ sessionID: "ses_test", callID: "a" })
    else if (finish === "cancel") await f.event("session.error", { error: { name: "MessageAbortedError" } })
    else if (finish === "delete") await f.event("session.deleted", { info: { id: "ses_test" } })
    else await f.event("message.part.updated", { part: {
      type: "tool", sessionID: "ses_test", callID: "a", tool: "bash", state: { status: finish },
    } })
    await f.advance(30 * 60000)
    assert.equal(f.posts.length, 0, finish)
    await f.hooks.dispose()
  }
})

test("approval time is excluded for the blocked tool while other tools can still alert", async () => {
  const f = fixture({ events: { input: false } })
  for (const callID of ["a", "b"]) await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID, tool: "bash" })
  await f.advance(5 * 60000)
  await f.event("permission.asked", { id: "p", permission: "bash", tool: { callID: "a" } })
  await f.advance(30 * 60000)
  assert.equal(f.posts.length, 1)
  assert.match(f.posts[0].embeds[0].description, /35m 0s/)
  await f.event("permission.replied", { requestID: "p" })
  await f.advance(15 * 60000)
  assert.equal(f.posts.length, 1)
  await f.advance(1)
  assert.equal(f.posts.length, 2)
  assert.match(f.posts[1].embeds[0].description, /20m 0s/)
  await f.hooks.dispose()
})

test("long-tool alerts also cover child sessions", async () => {
  const f = fixture({}, { parentID: "ses_parent" })
  await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
  await f.advance(20 * 60000 + 1)
  await f.event("session.idle")
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Long-running tool"])
  await f.hooks.dispose()
})

test("live type and threshold changes apply to already-running tools and queued notifications", async () => {
  const f = fixture({ events: { longTool: false } })
  await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
  await f.advance(21 * 60000)
  assert.equal(f.posts.length, 0)
  f.updateSettings({ webhookUrl, longToolMinutes: 25 })
  await f.advance(4 * 60000)
  assert.equal(f.posts.length, 0)
  await f.advance(1)
  assert.equal(f.posts.length, 1)
  const idle = f.event("session.idle")
  f.updateSettings({ webhookUrl, events: { ready: false } })
  await idle
  await f.flush()
  assert.deepEqual(f.titles(), ["OpenCode - Long-running tool"])
  await f.hooks.dispose()
})

test("settings updates preserve the webhook and unrelated settings, and reject invalid changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-settings-"))
  const path = join(directory, "config.json")
  try {
    await writeFile(path, JSON.stringify({ webhookUrl, events: { started: false }, custom: "keep-me" }))
    await updateSettingsFile(path, { events: { ready: false } }, {})
    const config = JSON.parse(await readFile(path, "utf8"))
    assert.equal(config.webhookUrl, webhookUrl)
    assert.equal(config.custom, "keep-me")
    assert.deepEqual(config.events, { started: false, ready: false })
    const before = await readFile(path, "utf8")
    await assert.rejects(updateSettingsFile(path, { longToolMinutes: 0 }, {}))
    await assert.rejects(updateSettingsFile(path, { readyMinMinutes: -1 }, {}))
    assert.equal(await readFile(path, "utf8"), before)
    assert.deepEqual(await readdir(directory), ["config.json"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("saved settings are reloaded into a running notifier without restarting it", { timeout: 6000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-reload-"))
  const path = join(directory, "config.json")
  const f = fixture({ events: { longTool: false } })
  let stopWatching
  let deadline
  try {
    await writeFile(path, JSON.stringify({ webhookUrl, events: { longTool: false } }))
    let applied
    const updated = new Promise((resolve, reject) => {
      applied = resolve
      deadline = setTimeout(() => reject(new Error("Settings were not reloaded")), 4500)
    })
    stopWatching = watchSettings(path, (settings) => { f.updateSettings(settings); applied(settings) }, () => {}, {})
    await f.hooks["tool.execute.before"]({ sessionID: "ses_test", callID: "a", tool: "bash" })
    await f.advance(21 * 60000)
    assert.equal(f.posts.length, 0)
    await updateSettingsFile(path, { events: { longTool: true }, readyMinMinutes: 10 }, {})
    assert.equal((await updated).readyMinMinutes, 10)
    await f.advance(1)
    assert.deepEqual(f.titles(), ["OpenCode - Long-running tool"])
  } finally {
    clearTimeout(deadline)
    await stopWatching?.()
    await f.hooks.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

function controlsFixture() {
  let settings = normalizeSettings({ webhookUrl })
  const commands = []
  const saves = []
  const toasts = []
  const disposers = []
  let dialog
  registerNotificationControls({
    keymap: { registerLayer(layer) { commands.push(...layer.commands); return () => {} } },
    lifecycle: { onDispose(fn) { disposers.push(fn) } },
    ui: {
      toast(value) { toasts.push(value) },
      DialogSelect: (props) => ({ kind: "select", ...props }),
      DialogPrompt: (props) => ({ kind: "prompt", ...props }),
      dialog: { replace(render) { dialog = render() }, clear() { dialog = undefined } },
    },
  }, {
    read: async () => settings,
    save: async (patch) => {
      saves.push(patch)
      settings = normalizeSettings({ ...settings, ...patch, events: { ...settings.events, ...patch.events } })
    },
  })
  return { commands, saves, toasts, disposers, dialog: () => dialog }
}

test("/notify registers a native settings menu and toggles notification types without a model request", async () => {
  const f = controlsFixture()
  assert.equal(f.commands[0].slashName, "notify")
  assert.equal(f.disposers.length, 1)
  await f.commands[0].run()
  assert.equal(f.dialog().kind, "select")
  assert.match(f.dialog().options.find((option) => option.value === "started").title, /OFF/)
  f.dialog().onSelect({ value: "ready" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.saves, [{ events: { ready: false } }])
  assert.equal(f.toasts.at(-1).variant, "success")
  await f.commands[0].run()
  assert.match(f.dialog().options.find((option) => option.value === "ready").title, /OFF/)
})

test("/notify validates the long-tool threshold before saving it", async () => {
  const f = controlsFixture()
  await f.commands[0].run()
  f.dialog().onSelect({ value: "threshold" })
  assert.equal(f.dialog().kind, "prompt")
  assert.equal(f.dialog().value, "20")
  f.dialog().onConfirm("zero")
  assert.equal(f.saves.length, 0)
  assert.equal(f.toasts.at(-1).variant, "error")
  f.dialog().onConfirm("30")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.saves, [{ longToolMinutes: 30 }])
})

test("/notify shows the five-minute response-ready minimum and saves validated changes", async () => {
  const f = controlsFixture()
  await f.commands[0].run()
  assert.match(f.dialog().options.find((option) => option.value === "readyThreshold").title, /5 minutes/)
  f.dialog().onSelect({ value: "readyThreshold" })
  assert.equal(f.dialog().value, "5")
  for (const value of ["", "-1", "not a number"]) f.dialog().onConfirm(value)
  assert.equal(f.saves.length, 0)
  f.dialog().onConfirm("10")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.saves, [{ readyMinMinutes: 10 }])
  await f.commands[0].run()
  f.dialog().onSelect({ value: "readyThreshold" })
  f.dialog().onConfirm("0")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.saves.at(-1), { readyMinMinutes: 0 })
})
