import { createNotifier } from "./notifier.mjs"
import { readSettings, settingsPath, watchSettings } from "./settings.mjs"

export default async function DiscordNotify(context) {
  try {
    const settings = await readSettings(settingsPath)
    let stopWatching
    const notifier = createNotifier(context, settings, { onDispose: () => stopWatching?.() })
    stopWatching = watchSettings(settingsPath, (next) => notifier.updateSettings(next), () =>
      context.client.app.log({ body: {
        service: "discord-notify", level: "warn",
        message: "Could not reload Discord notification settings; keeping the previous settings.",
      } }))
    return notifier.hooks
  } catch {
    try {
      await context.client.app.log({ body: {
        service: "discord-notify", level: "warn",
        message: "Discord notifications are disabled: check discord-notify/config.json or OPENCODE_DISCORD_WEBHOOK_URL.",
      } })
    } catch {}
    return {}
  }
}
