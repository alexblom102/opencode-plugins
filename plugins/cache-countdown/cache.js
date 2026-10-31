// Provider documentation checked on 2026-10-13; links and assumptions are in README.md.
// OpenCode reports cache usage, not an authoritative cache-entry expiry timestamp.

function seconds(value, name, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 86400) {
    throw new TypeError(`${name} must be an integer ${allowZero ? "0" : "1"}..86400`)
  }
  return value
}

function ttlMap(value, name) {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object mapping IDs to TTL seconds`)
  }
  return Object.fromEntries(Object.entries(value).map(([key, ttl]) => [key, seconds(ttl, `${name}.${key}`)]))
}

export function parseOptions(options = {}) {
  return {
    ttlSeconds: options.ttlSeconds === undefined ? undefined : seconds(options.ttlSeconds, "ttlSeconds"),
    warningSeconds: seconds(options.warningSeconds ?? 60, "warningSeconds", true),
    providerTtlSeconds: ttlMap(options.providerTtlSeconds, "providerTtlSeconds"),
    modelTtlSeconds: ttlMap(options.modelTtlSeconds, "modelTtlSeconds"),
  }
}

export function cachePolicy(providerID, modelID, options, apiModelID = modelID) {
  const modelKey = `${providerID}/${modelID}`
  const modelOverride = Object.hasOwn(options.modelTtlSeconds, modelKey)
    ? options.modelTtlSeconds[modelKey]
    : undefined
  const providerOverride = Object.hasOwn(options.providerTtlSeconds, providerID)
    ? options.providerTtlSeconds[providerID]
    : undefined
  const override = modelOverride ?? providerOverride ?? options.ttlSeconds
  if (override !== undefined) return { ttlSeconds: override, reason: "Configured display TTL" }

  const model = apiModelID.toLowerCase()
  if (model.includes("claude") || providerID === "anthropic") {
    return { ttlSeconds: 300, reason: "Claude default 5-minute TTL; override if using 1-hour caching" }
  }

  const gpt = model.match(/(?:^|[/:.])gpt-(\d+)(?:[.-](\d+))?(?:\D|$)/)
  if (gpt) {
    const major = Number(gpt[1])
    const minor = Number(gpt[2] ?? 0)
    if (major >= 6 || (major === 5 && minor >= 6)) {
      return { ttlSeconds: 1800, reason: "OpenAI GPT-5.6+ default 30-minute minimum lifetime; may last longer" }
    }
    if (major === 5 && minor === 5) {
      return { ttlSeconds: 1800, reason: "OpenAI GPT-5.5 extended retention: typical 30-minute window, not exact expiry" }
    }
    return { ttlSeconds: 300, reason: "Older OpenAI model: conservative 5-minute inactivity estimate; retention varies" }
  }
  if (/(?:^|[/:.])o[134](?:-|$)/.test(model)) {
    return { ttlSeconds: 300, reason: "OpenAI reasoning model: conservative 5-minute inactivity estimate; retention varies" }
  }
  return { ttlSeconds: undefined, reason: "Unknown provider/model cache lifetime; configure a display TTL" }
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

// Selecting from persisted message timestamps also restores the countdown on resume.
// Usage-free pending/error/shell messages do not refresh an earlier cache window.
export function latestActivity(messages, partsFor = () => []) {
  let latest
  for (const message of messages) {
    if (message.role !== "assistant" || message.summary) continue
    const startedAt = message.time?.created
    if (!Number.isFinite(startedAt) || startedAt <= 0) continue
    const steps = partsFor(message.id).filter((part) => part.type === "step-finish")
    const tokens = steps.length ? steps[steps.length - 1].tokens : message.tokens
    const read = tokenCount(tokens?.cache?.read)
    const write = tokenCount(tokens?.cache?.write)
    const used = read + write + tokenCount(tokens?.input) + tokenCount(tokens?.output) + tokenCount(tokens?.reasoning)
    if (!used) continue
    if (latest && latest.startedAt > startedAt) continue
    latest = {
      messageID: message.id,
      providerID: message.providerID,
      modelID: message.modelID,
      startedAt,
      read,
      write,
    }
  }
  return latest
}

export function formatDuration(secondsLeft) {
  const total = Math.max(0, Math.ceil(secondsLeft))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  return hours ? `${hours}:${mmss}` : mmss
}

export function countdown(activity, now, options, apiModelID) {
  if (!activity) return { label: "Cache: waiting", color: "textMuted", status: "waiting" }
  if (activity.read + activity.write === 0) {
    return { label: "Cache: no usage", color: "textMuted", status: "uncached" }
  }
  const policy = cachePolicy(activity.providerID, activity.modelID, options, apiModelID)
  if (policy.ttlSeconds === undefined) {
    return { label: "Cache: TTL unknown", color: "textMuted", status: "unknown", policy }
  }
  if (activity.startedAt > now + 1000) {
    return { label: "Cache: clock skew", color: "warning", status: "clock-skew", policy }
  }
  const expiresAt = activity.startedAt + policy.ttlSeconds * 1000
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return {
    label: secondsLeft ? `Cache ~${formatDuration(secondsLeft)}` : "Cache: TTL elapsed",
    color: secondsLeft === 0 ? "textMuted" : secondsLeft <= options.warningSeconds ? "warning" : "success",
    status: secondsLeft ? "active" : "elapsed",
    secondsLeft,
    expiresAt,
    policy,
  }
}

export function describe(activity, state) {
  if (!activity) return "Waiting for a model response with token usage in this session."
  const identity = `${activity.providerID}/${activity.modelID}`
  const usage = `Last request: ${activity.read.toLocaleString()} cached tokens read, ${activity.write.toLocaleString()} written.`
  if (state.status === "uncached") return `${identity}\n${usage}\nNo cache usage was reported for this request.`
  if (state.status === "clock-skew") return `${identity}\n${usage}\nServer timestamps are ahead of the local clock; check the clocks.`
  const policy = state.policy?.reason ?? "Cache lifetime unknown"
  const timing = state.expiresAt
    ? `Estimated window ends: ${new Date(state.expiresAt).toLocaleTimeString()}.`
    : "Set providerTtlSeconds or modelTtlSeconds in tui.json to enable the countdown."
  return `${identity}\n${usage}\n${policy}.\n${timing}\nEstimate from request start; actual cache availability and prefix matches can differ.`
}
