# Cache Countdown

Displays a live estimate such as `Cache ~28:00` beside the session prompt.
Click it or use `/cache` to see the model, reported cache reads/writes and the
policy behind the estimate.

Install from the collection root:

```sh
node install.mjs cache-countdown
```

Quit and restart OpenCode. No runtime npm dependency is required.

## Options

The installer adds `"./cache-countdown/tui.js"` to your `tui.json`. Replace that
string with an options pair to customize it:

```json
[
  "./cache-countdown/tui.js",
  {
    "warningSeconds": 60,
    "providerTtlSeconds": { "anthropic": 300 },
    "modelTtlSeconds": { "anthropic/claude-sonnet-4-6": 3600 }
  }
]
```

Optional `ttlSeconds` supplies a fallback TTL for all models. Model overrides
take precedence over provider overrides, then the fallback. TTL values are
positive integers up to 86400 seconds; `warningSeconds` may also be zero.

The countdown uses the model request's recorded start time, so generation time
consumes the window and session resume does not reset it. Unknown cache policies
remain unknown until a display TTL is configured. Defaults include a five-minute
Claude window and model-dependent OpenAI estimates.

This is an estimate, not a cache-expiration signal. OpenCode exposes cache usage
but not an authoritative eviction timestamp; provider policy and matching prompt
prefixes determine actual cache availability. Check the provider's current
documentation when setting a custom TTL:

- <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- <https://developers.openai.com/api/docs/guides/prompt-caching>
