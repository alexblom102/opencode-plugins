# Discord notifications

From the repository root: `node install.mjs discord-notify`.

Set `OPENCODE_DISCORD_WEBHOOK_URL` before launching OpenCode, or copy the installed
`discord-notify/config.example.json` to `config.json` and fill in `webhookUrl`.
Restart OpenCode and any separate server. **`/notify`** controls types and thresholds;
settings are global and reload automatically.

Defaults: response-ready after **>5 min**, tools after **>20 min** (once per call),
plus input-needed, errors and cancellation. Started/progress are off. Messages
show project, session and elapsed time, with short details where needed.
