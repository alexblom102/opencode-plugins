# Tool Stopwatch

A live timer panel at the bottom of OpenCode's terminal UI:

```text
Tool timers
bash · Run tests                                  ⏱ 0:12
read · src/main.ts                                ✓ 0:01
```

Install from the collection root:

```sh
node install.mjs tool-stopwatch
```

Quit and restart OpenCode. `/tool-timers` toggles the panel and saves the
preference. UI modules are supplied by OpenCode; no runtime npm package is
needed.

Each running tool has an independent stopwatch, including parallel calls.
Completed calls show `✓` and errors/cancellations show `×`; final durations stay
for five seconds. The panel collapses when empty. Recorded start times recover
elapsed time when reopening a session. Timing includes permission/user waits
inside OpenCode's running interval and excludes argument streaming. Missing
timestamps use an explicitly approximate `~` value or an unknown `—` duration.

## Options

The installer adds `"./tool-stopwatch/tui.js"` to `tui.json`. Replace that string
with an options pair to customize it:

```json
[
  "./tool-stopwatch/tui.js",
  {
    "refreshMs": 1000,
    "keepCompletedSeconds": 5,
    "maxCompleted": 3,
    "showInputs": true
  }
]
```

`refreshMs` is clamped to 250–5000 ms, `keepCompletedSeconds` to 0–300 seconds,
and `maxCompleted` to 0–50. Set either completed option to zero for running calls
only. All running calls remain visible regardless of the completed-row limit.
Set `showInputs: false` to display tool names without short descriptions.

The additive `app_bottom` slot remains visible during question and permission
prompts. OpenCode 1.19.0 does not expose a plugin slot beside transcript tool
rows, so this plugin uses a compact panel.

## Moving from the old standalone repository

The collection uses the same installation directory, plugin ID, and saved
visibility key as the standalone installer. Run the collection installer to
update the existing installation; its options and toggle preference are kept.
The standalone repository is now a legacy download location.
