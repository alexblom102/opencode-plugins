import { basename } from "node:path"
import { normalizeSettings, validateWebhook } from "./settings.mjs"

export { readSettings, validateWebhook } from "./settings.mjs"

const clip = (value, length) => String(value ?? "").slice(0, length)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function postDiscord(webhookUrl, payload, runtime = {}) {
  const url = new URL(validateWebhook(webhookUrl))
  url.searchParams.set("wait", "false")
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await (runtime.fetch ?? fetch)(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    })
    if (response.ok) return
    if (response.status === 429 && attempt === 0) {
      const body = await response.json().catch(() => ({}))
      const seconds = Number(body.retry_after ?? response.headers.get("retry-after") ?? 1)
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
        await (runtime.sleep ?? sleep)(Math.max(250, seconds * 1000))
        continue
      }
    }
    throw new Error(`Discord notification failed (HTTP ${response.status})`)
  }
}

export function createNotifier({ client, directory }, initialSettings, runtime = {}) {
  let settings = normalizeSettings(initialSettings)
  const now = runtime.now ?? Date.now
  const sessions = new Map()
  let disposed = false
  let queue = Promise.resolve()

  function stateFor(id) {
    if (!sessions.has(id)) sessions.set(id, {
      id, active: false, startedAt: now(), lastProgressAt: now(),
      signature: "", pendingProgress: false, waiting: new Map(),
      tools: new Map(), finishedTools: new Set(), info: undefined, lookup: undefined,
    })
    return sessions.get(id)
  }

  const enabled = (kind) => settings.enabled && settings.events[kind]

  function notify(state, kind, title, detail = "", color = 0x5865f2) {
    const elapsedMs = Math.max(0, now() - state.startedAt)
    const eligible = () => enabled(kind) && (kind !== "ready" || settings.readyMinMinutes === 0 || elapsedMs > settings.readyMinMinutes * 60000)
    if (!eligible()) return
    const elapsed = Math.floor(elapsedMs / 1000)
    queue = queue.then(async () => {
      if (disposed || !eligible()) return
      if (!state.info && !state.lookup) {
        state.lookup = Promise.resolve().then(() => client.session.get({
          path: { id: state.id }, signal: AbortSignal.timeout(2000),
        })).then((result) => { state.info ??= result.data }).catch(() => {})
      }
      await state.lookup
      if (disposed || !eligible() || (state.info?.parentID && !settings.includeSubagents && kind !== "longTool")) return
      await postDiscord(settings.webhookUrl, {
        username: "OpenCode",
        embeds: [{
          title: `OpenCode - ${title}`,
          description: detail ? clip(detail, 600) : undefined,
          color,
          fields: [
            { name: "Project", value: clip(basename(directory) || directory || "OpenCode", 200), inline: true },
            { name: "Session", value: clip(state.info?.title || "Untitled session", 200), inline: true },
            { name: "Elapsed", value: `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`, inline: true },
          ],
        }],
      }, runtime)
    }).catch(async () => {
      // Fetch errors can contain the credential-bearing URL; log only this fixed message.
      try {
        await client.app.log({ body: {
          service: "discord-notify", level: "warn",
          message: "Discord notification could not be delivered; check the webhook and network.",
        } })
      } catch {}
    })
  }

  function start(state) {
    if (state.active) return
    Object.assign(state, {
      active: true, startedAt: now(), lastProgressAt: now(),
      signature: "", pendingProgress: false,
    })
    state.tools.clear()
    state.finishedTools.clear()
    state.waiting.clear()
    notify(state, "started", "Started")
  }

  function finish(state) {
    if (!state.active || state.waiting.size) return
    state.active = false
    state.pendingProgress = false
    state.tools.clear()
    notify(state, "ready", "Response ready", "", 0x57f287)
  }

  function blocked(state, callID) {
    return [...state.waiting.values()].some((request) => !request.callID || request.callID === callID)
  }

  function trackTool(state, callID, name, startedAt = now()) {
    if (!callID || state.finishedTools.has(callID)) return
    if (!state.tools.has(callID)) state.tools.set(callID, {
      name, startedAt, alerted: false, pausedMs: 0,
      pausedAt: blocked(state, callID) ? now() : undefined,
    })
    const tool = state.tools.get(callID)
    tool.name = name
    tool.startedAt = Math.min(tool.startedAt, startedAt)
  }

  function completeTool(state, callID) {
    state.tools.delete(callID)
    state.finishedTools.add(callID)
  }

  function updatePauses(state) {
    for (const [callID, tool] of state.tools) {
      if (blocked(state, callID)) tool.pausedAt ??= now()
      else if (tool.pausedAt !== undefined) {
        tool.pausedMs += now() - tool.pausedAt
        tool.pausedAt = undefined
      }
    }
  }

  function tick() {
    for (const state of sessions.values()) {
      if (!state.active) continue
      for (const tool of state.tools.values()) {
        const elapsed = now() - tool.startedAt - tool.pausedMs
        if (enabled("longTool") && !tool.alerted && tool.pausedAt === undefined && elapsed > settings.longToolMinutes * 60000) {
          tool.alerted = true
          const seconds = Math.floor(elapsed / 1000)
          notify(state, "longTool", "Long-running tool",
            `**${clip(tool.name, 150)}** running for **${Math.floor(seconds / 60)}m ${seconds % 60}s**.`, 0xfee75c)
        }
      }
      if (state.waiting.size || !enabled("progress")) continue
      const elapsed = now() - state.lastProgressAt
      if ((state.pendingProgress && elapsed >= settings.progressIntervalSeconds * 1000) || elapsed >= settings.heartbeatSeconds * 1000) {
        notify(state, "progress", "Progress", state.pendingProgress ? "Task progress updated." : "Still working.")
        state.lastProgressAt = now()
        state.pendingProgress = false
      }
    }
  }

  const timer = (runtime.setInterval ?? setInterval)(tick, 1000)
  timer.unref?.()

  const hooks = {
    async event({ event }) {
      if (disposed) return
      const props = event.properties ?? {}
      if (event.type === "server.instance.disposed" && props.directory === directory) {
        await hooks.dispose()
        return
      }
      if (["session.created", "session.updated", "session.deleted"].includes(event.type)) {
        if (!props.info?.id) return
        if (event.type === "session.deleted") sessions.delete(props.info.id)
        else stateFor(props.info.id).info = props.info
        return
      }
      if (event.type === "message.part.updated" && props.part?.type === "tool") {
        const part = props.part
        if (!part.sessionID || !part.callID) return
        const state = stateFor(part.sessionID)
        if (part.state?.status === "running") {
          start(state)
          const timestamp = part.state.time?.start
          trackTool(state, part.callID, part.tool,
            Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : now())
        } else if (["completed", "error"].includes(part.state?.status)) completeTool(state, part.callID)
        return
      }
      if (!props.sessionID && event.type !== "session.error") return
      const state = stateFor(props.sessionID ?? "opencode")
      switch (event.type) {
        case "session.status":
          if (["busy", "retry"].includes(props.status?.type)) start(state)
          else if (props.status?.type === "idle") finish(state)
          break
        case "session.idle":
          finish(state)
          break
        case "todo.updated": {
          const todos = props.todos ?? []
          const signature = JSON.stringify(todos.map(({ content, status }) => [content, status]))
          if (state.active && signature !== state.signature) {
            state.signature = signature
            state.pendingProgress = true
          }
          break
        }
        case "permission.updated":
        case "permission.asked":
        case "permission.v2.asked":
        case "question.asked":
        case "question.v2.asked": {
          const requestID = props.id ?? event.type
          if (state.waiting.has(requestID)) break
          state.waiting.set(requestID, { callID: props.tool?.callID ?? props.callID })
          updatePauses(state)
          const detail = event.type.startsWith("question.")
            ? clip((props.questions ?? []).map((question) => question.question).join("\n"), 300)
            : `Approval needed: ${clip(props.permission ?? props.action ?? props.type ?? "tool execution", 150)}`
          notify(state, "input", "Your input is needed", detail, 0xfee75c)
          break
        }
        case "permission.replied":
        case "permission.v2.replied":
        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "question.v2.rejected":
          state.waiting.delete(props.requestID ?? props.permissionID ?? props.id)
          updatePauses(state)
          state.lastProgressAt = now()
          break
        case "session.error":
          state.active = false
          state.pendingProgress = false
          state.tools.clear()
          state.waiting.clear()
          notify(state, props.error?.name === "MessageAbortedError" ? "stopped" : "error",
            props.error?.name === "MessageAbortedError" ? "Stopped" : "Error",
            props.error?.name === "MessageAbortedError" ? "" : clip(props.error?.name ?? "UnknownError", 120), 0xed4245)
          break
      }
    },
    async "tool.execute.before"(input) {
      if (disposed) return
      const state = stateFor(input.sessionID)
      start(state)
      trackTool(state, input.callID, input.tool)
    },
    async "tool.execute.after"(input) {
      const state = sessions.get(input.sessionID)
      if (state?.active) completeTool(state, input.callID)
    },
    async dispose() {
      disposed = true
      ;(runtime.clearInterval ?? clearInterval)(timer)
      sessions.clear()
      await runtime.onDispose?.()
      await queue
    },
  }
  return {
    hooks, flush: () => queue,
    updateSettings(next) { if (!disposed) settings = normalizeSettings(next) },
  }
}
