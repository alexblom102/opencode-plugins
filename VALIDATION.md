# Verification

Verified locally with OpenCode 1.19.0, Node 26.7.0 and npm 11.19.0 on Windows.

- **130 automated tests passed:** 16 stopwatch checks, 16 cache-countdown checks,
  14 message-timestamp checks, 77 session-usage checks and seven
  collection-installer checks, including upgrades from the standalone stopwatch.
- The timestamp suite exercises the actual pinned SDK bridge with a mock
  transport, verifying authenticated routing and message-part update bodies.
- The installer was also run as a real command into an isolated configuration
  directory. It copied all four plugins, registered TUI and server entries in
  the appropriate configuration files, and installed the timestamp SDK locally
  in that plugin's own directory.
- Syntax and publication scans passed for all distributable source files.
- The 21 reviewed source/test files match the SHA-256 hashes recorded in
  `source-manifest.json`. Runtime implementation was preserved; documentation
  and package metadata were prepared separately for public distribution.

GitHub Actions runs the tests and publication checks on Windows, macOS and Linux.
See the repository's **Actions** tab for current results.

The source plugins were previously exercised in the OpenCode terminal. Private
local validation logs and usage observations are deliberately not distributed.
