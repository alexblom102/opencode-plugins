# Verification

Verified locally with OpenCode 1.19.0, Node 26.7.0 and npm 11.19.0 on Windows.

- **157 automated tests passed:** 16 stopwatch, 16 cache countdown,
  14 message timestamps, 77 session usage, 22 Discord notifications,
  10 installer and two publication checks.
- The timestamp suite exercises the actual pinned SDK bridge with a mock
  transport, verifying authenticated routing and message-part update bodies.
- Installer tests cover all five plugins, shared Discord settings across separate
  TUI/server configuration directories, preserving private webhook settings,
  repeated installation and legacy auto-loader upgrades without duplicate hooks.
- Discord checks cover the five-minute response minimum, per-call 20-minute tool
  alerts, parallel tools, permission waits, compact messages and live settings.
- Syntax and publication scans passed for all distributable source files.
- The 27 reviewed source/test/example files match the SHA-256 hashes recorded in
  `source-manifest.json`. Runtime implementation was preserved; documentation
  and package metadata were prepared separately for public distribution.

GitHub Actions runs the tests and publication checks on Windows, macOS and Linux.
See the repository's **Actions** tab for current results.

The source plugins were previously exercised in the OpenCode terminal. Private
local validation logs and usage observations are deliberately not distributed.
