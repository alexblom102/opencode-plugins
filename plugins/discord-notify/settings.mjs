import { randomUUID } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export const settingsPath = new URL("./config.json", import.meta.url)
export const notificationTypes = [
  { key: "ready", label: "Response ready", enabled: true },
  { key: "input", label: "Your input is needed", enabled: true },
  { key: "error", label: "Error", enabled: true },
  { key: "stopped", label: "Stopped / cancelled", enabled: true },
  { key: "longTool", label: "Long-running tool", enabled: true },
  { key: "started", label: "Started", enabled: false },
  { key: "progress", label: "Progress / heartbeat", enabled: false },
]

export function validateWebhook(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new Error("Configure a valid Discord webhook URL")
  }
  return url.href
}

export function normalizeSettings(config = {}) {
  const events = Object.fromEntries(notificationTypes.map(({ key, enabled }) => [key, enabled]))
  for (const { key } of notificationTypes) {
    if (config.events?.[key] === undefined) continue
    if (typeof config.events[key] !== "boolean") throw new Error("Notification types must be true or false")
    events[key] = config.events[key]
  }
  const settings = {
    enabled: config.enabled !== false,
    webhookUrl: config.webhookUrl,
    heartbeatSeconds: Number(config.heartbeatSeconds ?? 60),
    progressIntervalSeconds: Number(config.progressIntervalSeconds ?? 15),
    longToolMinutes: Number(config.longToolMinutes ?? 20),
    readyMinMinutes: Number(config.readyMinMinutes ?? 5),
    includeSubagents: config.includeSubagents === true,
    events,
  }
  if (![settings.heartbeatSeconds, settings.progressIntervalSeconds].every((value) => Number.isFinite(value) && value >= 1)) {
    throw new Error("Notification intervals must be at least one second")
  }
  if (!Number.isFinite(settings.longToolMinutes) || settings.longToolMinutes < 1) {
    throw new Error("The long-running-tool threshold must be at least one minute")
  }
  if (!Number.isFinite(settings.readyMinMinutes) || settings.readyMinMinutes < 0) {
    throw new Error("The response-ready minimum must be zero or more minutes")
  }
  if (settings.enabled) settings.webhookUrl = validateWebhook(settings.webhookUrl)
  return settings
}

async function readConfig(path) {
  try {
    const config = JSON.parse(await readFile(path, "utf8"))
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error()
    return config
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw new Error("Cannot read Discord notification settings")
  }
}

export async function readSettings(path = settingsPath, env = process.env) {
  const config = await readConfig(path)
  return normalizeSettings({ ...config, webhookUrl: env.OPENCODE_DISCORD_WEBHOOK_URL || config.webhookUrl })
}

export async function updateSettingsFile(path, patch, env = process.env) {
  const config = await readConfig(path)
  const next = { ...config, ...patch, events: { ...config.events, ...patch.events } }
  const settings = normalizeSettings({ ...next, webhookUrl: env.OPENCODE_DISCORD_WEBHOOK_URL || next.webhookUrl })
  const filename = path instanceof URL ? fileURLToPath(path) : path
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temporary, filename)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return settings
}

export function watchSettings(path, onUpdate, onError = () => {}, env = process.env) {
  const filename = path instanceof URL ? fileURLToPath(path) : path
  let pending = Promise.resolve()
  let closed = false
  const reload = () => {
    pending = pending.then(async () => {
      if (closed) return
      try {
        const settings = await readSettings(path, env)
        if (!closed) await onUpdate(settings)
      } catch {
        try { await onError() } catch {}
      }
    })
  }
  watchFile(filename, { persistent: false, interval: 1000 }, reload)
  return async () => {
    closed = true
    unwatchFile(filename, reload)
    await pending
  }
}
