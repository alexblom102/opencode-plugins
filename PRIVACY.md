# Publication review and runtime data

## Published contents

Only the explicitly selected plugin JavaScript modules and their reviewed synthetic
tests were transferred into this repository. Documentation and package metadata
were prepared for public distribution. The original local README and validation
reports were not copied: they contained machine-specific paths and local usage
observations.

No personal configuration, authentication files, webhook credentials, API keys, provider-account
settings, conversation databases, session ledgers, usage exports, pricing
caches, screenshots, logs or local backups are included. `source-manifest.json`
lists the selected logical source paths and their SHA-256 hashes, without
original filesystem locations.

Credential-shaped values such as `PRIVATE`, `SECRET`, and `Basic fixture` in
tests are deliberate dummy strings used to verify that sensitive input is not
retained. The tests' message/session IDs and token counters are synthetic.

## Runtime behavior

- **Tool stopwatch:** reads the current session's tool timing/display metadata
  and saves its panel-visibility preference locally. It does not upload tool
  information or save tool output.
- **Cache countdown:** reads the current session's usage metadata and displays
  an estimated cache lifetime. It does not upload session information.
- **Session usage:** reads session metadata and token counters from the
  configured OpenCode server. It stores an accounting ledger locally in
  OpenCode's state; the ledger includes session titles, identifiers, usage and
  timing metadata. `/usage-export` writes local JSON reports. Pricing is fetched
  from the public `https://models.dev/api.json` feed (or an explicitly configured
  alternative); session information is not sent with that pricing request.
- **Message timestamps:** writes labels into messages on the configured
  OpenCode server. They remain in saved history and exports, and are removed
  from the history passed to the model. They use the server machine's local
  timezone. No third-party service is involved.
- **Discord notifications:** sends the project name, session title and elapsed
  time to the user's configured Discord webhook. Input alerts include a short
  question or permission type; tool alerts include a tool name and running time.
  Task lists, tool output and full error messages are not included. Settings are
  stored locally; the installer never replaces `discord-notify/config.json`.
  The webhook can instead be supplied through `OPENCODE_DISCORD_WEBHOOK_URL`.

Only the optional, explicitly configured Discord notifier sends notification
content to a third party. Generated state, webhook settings and exports are
excluded by `.gitignore` and rejected by the publication checks.
