# Session Usage

Adds a status line such as:

```text
Usage 12,345 | 25.0 tok/s | TTFT 2.4s | API ~$0.12
```

Install from the collection root:

```sh
node install.mjs session-usage
```

Quit and restart OpenCode. UI dependencies are supplied by OpenCode itself.

## Commands

- `/usage`: opens token totals, performance statistics, model/provider/agent
  breakdowns and estimated API-equivalent cost. Clicking the status opens it too.
- `/usage-export`: saves a local JSON report under OpenCode's state directory at
  `session-usage/exports/` and shows its path.
- `/usage-prices`: refreshes the independent models.dev price catalog.

These are local TUI commands and do not send a new model prompt.

## Accounting and timing

Input, output, reasoning, cache-read and cache-write counters are disjoint and
summed once. Step-finish usage supersedes message-level totals. Repeated events,
history refreshes and restarts do not duplicate reported requests. The main
session and recursive subagents are included by default. Inherited fork history
is excluded from that fork's charges.

Already-observed usage remains recorded after deletion or undo, because the
requests already occurred. History from before installation can only be
recovered while it remains available from OpenCode.

- **Tokens/sec:** reasoning plus output divided by measured tool-free model
  time. Overlapping tool intervals are merged and recorded concurrent model
  output is preserved. Group rates are weighted by model time.
- **TTFT:** time from the live response-start event to its first nonempty answer
  text. Thinking time is included. The latest main-session response supplies the
  status value; historical estimates are marked `~`.
- **Response latency:** completion minus creation, including tool execution.
  Details include average, median, p95, minimum and maximum values.

Missing timing or usage remains unknown rather than being treated as zero.

## Prices and options

API-equivalent costs use independent public rate cards from
<https://models.dev/api.json>, refreshed every 24 hours and cached locally.
Subscription-provider zero rates do not erase the equivalent API estimate.
Each request uses its own provider/model and context tier. This is a rate-card
estimate, not an invoice or subscription charge.

The installer adds `"./session-usage/tui.js"` to `tui.json`. Options can be set
using an entry such as:

```json
[
  "./session-usage/tui.js",
  {
    "includeChildren": true,
    "pricingRefreshHours": 24,
    "providerAliases": {},
    "modelAliases": {},
    "prices": {}
  }
]
```

Set `includeChildren: false` to restrict accounting to the selected session.
`providerAliases` maps a custom provider ID to its pricing provider.
`modelAliases` maps an exact `provider/model` key to a catalog key. `prices`
overrides exact `provider/model` keys with USD-per-million fields `input`,
`output`, `reasoning`, `cacheRead` and `cacheWrite`. An optional `tiers` array
supplies complete tariffs above `aboveInputTokens` thresholds. Explicit zero
overrides are supported. `pricingURL` can select a models.dev-format feed.

Restart OpenCode after changing options. The local ledger contains session
titles and accounting/timing metadata, without prompt or response text. See
[PRIVACY.md](../../PRIVACY.md).
