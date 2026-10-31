# OpenCode Plugins

All four plugins in one repository, with one installer and one update command.
Verified on **OpenCode 1.19.0**.

| Plugin | What it adds | Commands |
| --- | --- | --- |
| [Tool stopwatch](plugins/tool-stopwatch/README.md) | An independent live timer for every running tool call | `/tool-timers` |
| [Cache countdown](plugins/cache-countdown/README.md) | An estimated prompt-cache lifetime beside the prompt | `/cache` |
| [Session usage](plugins/session-usage/README.md) | Token totals, tool-free tokens/sec, answer TTFT, API-equivalent costs and session statistics | `/usage`, `/usage-export`, `/usage-prices` |
| [Message timestamps](plugins/message-timestamps/README.md) | Local date/time labels on questions and completed final answers | Automatic |

## Install on another PC

Install [Node.js](https://nodejs.org/) 20+ and OpenCode, then run:

```sh
git clone https://github.com/alexblom102/opencode-plugins.git
cd opencode-plugins
node install.mjs
```

**Quit and restart OpenCode.** Message timestamps are a server plugin, so restart
a separately running OpenCode server too if you use `opencode attach`.

The installer works on Windows, macOS and Linux. It copies the selected plugins
into OpenCode's configuration directory, then adds their relative entries to
`tui.json` and/or `opencode.json`. Existing settings, plugin options and JSONC
comments are preserved. An edited configuration gets an exact backup.

The message-timestamp plugin needs the OpenCode SDK; its installer runs npm in
that plugin's own directory to install the pinned dependency. The three TUI
plugins use UI modules supplied by OpenCode and need no npm runtime packages.

### Install only selected plugins

```sh
node install.mjs cache-countdown session-usage
node install.mjs tool-stopwatch
node install.mjs message-timestamps
```

### Custom configuration locations

The default is `~/.config/opencode/`, including on Windows. The installer respects
`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TUI_CONFIG`, and
`OPENCODE_CONFIG`. You can also select explicit locations:

```sh
node install.mjs --config-dir "/path/to/opencode"
node install.mjs --tui-config "/path/to/tui.jsonc" --server-config "/path/to/opencode.jsonc"
```

If both JSON and JSONC versions of a configuration exist, choose one with the
corresponding explicit option. Run `node install.mjs --help` for usage.

### Update

From the checkout:

```sh
git pull --ff-only
node install.mjs
```

Then restart OpenCode (and its server for message timestamps). Reinstalling
updates the plugin files without adding duplicate registrations. If you installed
only a subset, pass the same plugin names when updating.

### Already using the standalone stopwatch?

Run this collection's installer. It uses the same `tool-stopwatch` installation
directory and preserves an existing registration, custom options and saved panel
visibility. The old standalone repository now points here; future updates are
published in this all-in-one collection.

### Without Git

Use **Code → Download ZIP**, extract the download and run `node install.mjs` from
the extracted folder. You can delete the checkout after installation.

### Remove a plugin

Remove its entry from the relevant configuration and restart OpenCode. The
plugin directory can then be deleted. Existing message labels and previously
recorded local usage are retained.

## Source and data handling

This repository contains reviewed plugin source, synthetic test fixtures and
generic documentation. Personal OpenCode settings, credentials, conversation
history, usage exports, cached data and local validation notes are not part of
the distribution. See [PRIVACY.md](PRIVACY.md) for the publication review and
each plugin's runtime behavior.

## Development

```sh
npm ci
npm test
npm run check
```

The check command validates JavaScript syntax and scans distributable files for
common credential formats, private user-directory paths and accidental data
files. Tests use synthetic messages and offline pricing fixtures.

## License

MIT. See [LICENSE](LICENSE).
