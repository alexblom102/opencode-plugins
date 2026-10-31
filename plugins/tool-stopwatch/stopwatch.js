export function parseOptions(raw = {}) {
  const options = raw && typeof raw === "object" ? raw : {}
  return {
    refreshMs: bounded(options.refreshMs, 1000, 250, 5000),
    keepCompletedSeconds: bounded(options.keepCompletedSeconds, 5, 0, 300),
    maxCompleted: Math.floor(bounded(options.maxCompleted, 3, 0, 50)),
    showInputs: options.showInputs !== false,
  }
}

function bounded(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function timestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function oneLine(value) {
  if (typeof value !== "string") return ""
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
}

export function toolSummary(state) {
  const input = state.input ?? {}
  for (const value of [input.description, state.title, input.filePath, input.path, input.pattern, input.url, input.query, input.command]) {
    const text = oneLine(value)
    if (text) return Array.from(text).slice(0, 80).join("")
  }
  return ""
}

// Snapshot only display/timing fields. Reading these fields here also establishes
// Solid's dependencies on in-place updates to OpenCode's reactive tool states.
export function sessionTools(state, sessionID, showInputs = true) {
  if (!sessionID) return []
  const messages = state.session.messages(sessionID)
  const revertID = state.session.get(sessionID)?.revert?.messageID
  const revertIndex = revertID ? messages.findIndex((message) => message.id === revertID) : -1
  const result = []
  for (const message of revertIndex === -1 ? messages : messages.slice(0, revertIndex)) {
    if (message.role !== "assistant") continue
    for (const part of state.part(message.id)) {
      if (part.type !== "tool" || part.sessionID !== sessionID) continue
      const status = part.state?.status
      if (!["pending", "running", "completed", "error"].includes(status)) continue
      result.push({
        id: `${message.id}:${part.id}`,
        tool: oneLine(part.tool),
        status,
        start: timestamp(part.state.time?.start),
        end: timestamp(part.state.time?.end),
        summary: showInputs ? toolSummary(part.state) : "",
      })
    }
  }
  return result
}

export function formatDuration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "—"
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const pad = (value) => String(value).padStart(2, "0")
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

// One tracker per mounted panel. IDs distinguish simultaneous calls to the same
// tool; the recorded start time makes restored sessions immediately accurate.
export function createTracker() {
  let sessionID
  const entries = new Map()
  return {
    sync(nextSessionID, tools, now = Date.now()) {
      if (sessionID !== nextSessionID) {
        entries.clear()
        sessionID = nextSessionID
      }
      const seen = new Set()
      for (const tool of tools) {
        seen.add(tool.id)
        const previous = entries.get(tool.id)
        if (tool.status === "pending") {
          entries.delete(tool.id)
          continue
        }
        const finished = tool.status === "completed" || tool.status === "error"
        const recordedStart = timestamp(tool.start)
        const recordedEnd = timestamp(tool.end)
        const start = recordedStart ?? previous?.start ?? (finished ? undefined : now)
        const end = finished ? recordedEnd ?? previous?.end ?? now : undefined
        entries.set(tool.id, {
          ...tool,
          start,
          end,
          finished,
          approximate: recordedStart === undefined || (finished && recordedEnd === undefined),
        })
      }
      for (const id of entries.keys()) if (!seen.has(id)) entries.delete(id)
      return [...entries.values()]
    },
  }
}

export function visibleTimers(entries, now, options = parseOptions()) {
  const running = entries.filter((entry) => !entry.finished)
  const completed = entries.filter((entry) => entry.finished &&
    options.keepCompletedSeconds > 0 && now - entry.end < options.keepCompletedSeconds * 1000)
    .sort((a, b) => b.end - a.end).slice(0, options.maxCompleted)
  return [...running, ...completed].map((entry) => {
    const elapsed = entry.start === undefined ? undefined : Math.max(0, (entry.end ?? now) - entry.start)
    return {
      ...entry,
      elapsed,
      label: `${entry.approximate && elapsed !== undefined ? "~" : ""}${formatDuration(elapsed)}`,
    }
  })
}
