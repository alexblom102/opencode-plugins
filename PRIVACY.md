# Publication review and runtime data

## Published contents

Only the explicitly selected plugin `.js` modules and their reviewed synthetic
tests were transferred into this repository. Documentation and package metadata
were prepared for public distribution. The original local README and validation
reports were not copied: they contained machine-specific paths and local usage
observations.

No personal configuration, authentication files, API keys, provider-account
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

Installing these plugins does not publish existing or future usage data. Do not
add generated state or export files to a source checkout; those paths are also
excluded by `.gitignore`.
