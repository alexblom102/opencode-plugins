import { notificationTypes, readSettings, settingsPath, updateSettingsFile } from "./settings.mjs"

export function registerNotificationControls(api, storage = {}) {
  const read = storage.read ?? (() => readSettings(settingsPath))
  const save = storage.save ?? ((patch) => updateSettingsFile(settingsPath, patch))
  const reportError = () => api.ui.toast({
    title: "Discord notifications", variant: "error",
    message: "Could not update notification settings. Check discord-notify/config.json.",
  })

  async function change(patch, message) {
    await save(patch)
    api.ui.dialog.clear()
    api.ui.toast({ title: "Discord notifications", variant: "success", message, duration: 6000 })
  }

  async function showMenu() {
    const settings = await read()
    const options = [
      { title: `Notifications: ${settings.enabled ? "ON" : "OFF"}`, value: "enabled", description: "Toggle all Discord notifications" },
      ...notificationTypes.map(({ key, label }) => ({
        title: `${label}: ${settings.events[key] ? "ON" : "OFF"}`, value: key,
        description: "Select to toggle this notification type",
      })),
      { title: `Response-ready minimum: ${settings.readyMinMinutes} minutes`, value: "readyThreshold", description: "Notify only when a response's elapsed time exceeds this minimum; 0 allows all" },
      { title: `Long-tool threshold: ${settings.longToolMinutes} minutes`, value: "threshold", description: "Change how long a tool runs before its one-time alert" },
      { title: `Child-session updates: ${settings.includeSubagents ? "ON" : "OFF"}`, value: "subagents", description: "Long-tool alerts always cover child sessions" },
    ]
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Discord notifications", options,
      onSelect(option) {
        if (["threshold", "readyThreshold"].includes(option.value)) {
          const ready = option.value === "readyThreshold"
          const key = ready ? "readyMinMinutes" : "longToolMinutes"
          const minimum = ready ? 0 : 1
          api.ui.dialog.replace(() => api.ui.DialogPrompt({
            title: ready ? "Response-ready minimum (minutes)" : "Long-running-tool threshold (minutes)",
            value: String(settings[key]), placeholder: ready ? "5" : "20",
            onConfirm(value) {
              const minutes = Number(value.trim())
              if (!value.trim() || !Number.isFinite(minutes) || minutes < minimum) {
                api.ui.toast({ title: "Discord notifications", variant: "error", message: `Enter a number of minutes, at least ${minimum}.` })
                return
              }
              const message = ready
                ? minutes === 0 ? "Response-ready notifications have no minimum duration." : `Response-ready notifications only after more than ${minutes} minutes.`
                : `Long-tool alerts after more than ${minutes} minutes.`
              void change({ [key]: minutes }, message).catch(reportError)
            },
            onCancel() { api.ui.dialog.clear() },
          }))
          return
        }
        if (option.value === "enabled") {
          void change({ enabled: !settings.enabled }, `Notifications ${settings.enabled ? "disabled" : "enabled"}.`).catch(reportError)
        } else if (option.value === "subagents") {
          void change({ includeSubagents: !settings.includeSubagents }, "Child-session notification setting saved.").catch(reportError)
        } else {
          const type = notificationTypes.find(({ key }) => key === option.value)
          if (type) void change({ events: { [type.key]: !settings.events[type.key] } },
            `${type.label} ${settings.events[type.key] ? "disabled" : "enabled"}.`).catch(reportError)
        }
      },
    }))
  }

  const unregister = api.keymap.registerLayer({ commands: [{
    name: "discord-notify.settings", title: "Discord notification settings",
    desc: "Choose notification types and duration thresholds",
    category: "Notifications", namespace: "palette", slashName: "notify",
    async run() {
      api.ui.dialog.clear()
      try { await showMenu() } catch { reportError() }
    },
  }] })
  if (typeof unregister === "function") api.lifecycle.onDispose(unregister)
}

export default {
  id: "local:discord-notify-controls",
  async tui(api) { registerNotificationControls(api) },
}
