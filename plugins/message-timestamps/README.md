# Message Timestamps

Adds local date/time labels above questions and completed final answers:

```text
[Asked: 2026-01-01 12:00:00 UTC+00:00]

Example question

[Answered: 2026-01-01 12:00:10 UTC+00:00]

Example answer
```

Install from the collection root:

```sh
node install.mjs message-timestamps
```

The installer installs the pinned OpenCode SDK in this plugin's directory and
adds `"./message-timestamps/server.js"` to `opencode.json`. **Restart OpenCode
and any separately running OpenCode server.**

- Questions use the recorded message creation time.
- Final answers use their recorded completion time, after streaming finishes.
- Dates, seconds and the server machine's local UTC offset are included.
- Intermediate tool steps, summaries, errors, interrupted answers, file-only
  prompts and structured JSON answers are skipped.
- Repeated events do not duplicate labels.
- Saved conversations and exports retain labels. The history-transform hook
  removes the labels from messages passed to the model.
- Existing history is not backfilled; labeling applies to new messages after
  activation.

Manual installation requires `npm install --omit=dev --ignore-scripts` in the
copied plugin directory to supply `@opencode-ai/sdk`. No API key is needed by the
plugin: it reuses the OpenCode server's existing authenticated SDK transport.

To disable it, remove its entry from `opencode.json`/`opencode.jsonc` and restart
the server. Previously saved labels remain in history.
