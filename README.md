# OpenCode Plugins

For OpenCode **1.19** and Node.js **20+**.

| Plugin | Commands |
| --- | --- |
| [Tool stopwatch](plugins/tool-stopwatch) | `/tool-timers` |
| [Cache countdown](plugins/cache-countdown) | `/cache` |
| [Session usage](plugins/session-usage) | `/usage`, `/usage-export`, `/usage-prices` |
| [Message timestamps](plugins/message-timestamps) | Automatic |
| [Discord notifications](plugins/discord-notify) | `/notify` |

```sh
git clone https://github.com/alexblom102/opencode-plugins.git
cd opencode-plugins
node install.mjs
```

Restart OpenCode and any separate server. Select plugins with
`node install.mjs discord-notify tool-stopwatch`; use `--help` for custom paths.
Discord requires `OPENCODE_DISCORD_WEBHOOK_URL` or a local `discord-notify/config.json`.

Update: `git pull --ff-only`, then rerun the installer. Existing settings are preserved.
Development: `npm ci`, `npm test`, `npm run check`. [Data handling](PRIVACY.md) · [MIT](LICENSE).
