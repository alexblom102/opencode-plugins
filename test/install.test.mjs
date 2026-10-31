import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { configPaths, installCollection } from "../install.mjs"

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "public-plugins-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("the full installer separates TUI/server entries and isolates the SDK dependency", async (t) => {
  const configDir = await temporary(t)
  const dependencies = []
  const result = await installCollection({ configDir, dependencyInstaller: async (directory) => dependencies.push(directory) })
  assert.equal(result.plugins.length, 4)
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "tui.json"), "utf8")).plugin, ["./cache-countdown/tui.js", "./session-usage/tui.js", "./tool-stopwatch/tui.js"])
  const server = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))
  assert.equal(server.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(server.plugin, ["./message-timestamps/server.js"])
  assert.deepEqual(dependencies, [path.join(configDir, "message-timestamps")])
  assert.equal(JSON.parse(await readFile(path.join(dependencies[0], "package.json"), "utf8")).dependencies["@opencode-ai/sdk"], "1.18.29")
})

test("TUI-only installs preserve existing JSONC comments, settings and options", async (t) => {
  const configDir = await temporary(t)
  const tui = path.join(configDir, "tui.jsonc")
  const original = '{\n // Keep my setup\n "theme": "custom",\n "plugin": [["./cache-countdown/tui.js", {"warningSeconds": 30}]],\n}\n'
  await writeFile(tui, original)
  const result = await installCollection({ configDir, names: ["cache-countdown", "session-usage"], dependencyInstaller: () => { throw new Error("unexpected npm") } })
  const contents = await readFile(tui, "utf8")
  assert.ok(contents.includes('// Keep my setup'))
  assert.ok(contents.includes('{"warningSeconds": 30}'))
  assert.ok(contents.includes('./session-usage/tui.js'))
  assert.equal(await readFile(result.backups[0], "utf8"), original)
  const again = await installCollection({ configDir, names: ["cache-countdown", "session-usage"] })
  assert.equal(again.backups.length, 0)
  assert.equal(await readFile(tui, "utf8"), contents)
})

test("unknown selections and malformed configurations fail before registration", async (t) => {
  const configDir = await temporary(t)
  await assert.rejects(installCollection({ configDir, names: ["unknown"] }), /Choose plugins/)
  const file = path.join(configDir, "tui.json")
  await writeFile(file, '{"plugin":false}')
  await assert.rejects(installCollection({ configDir, names: ["cache-countdown"] }), /Existing plugin/)
  assert.equal(await readFile(file, "utf8"), '{"plugin":false}')
})

test("failed dependency installation leaves configuration contents unchanged", async (t) => {
  const configDir = await temporary(t)
  const file = path.join(configDir, "opencode.json")
  await writeFile(file, '{"plugin":["existing"]}')
  await assert.rejects(installCollection({ configDir, names: ["message-timestamps"], dependencyInstaller: async () => { throw new Error("offline fixture") } }), /offline fixture/)
  assert.equal(await readFile(file, "utf8"), '{"plugin":["existing"]}')
})

test("explicit config files win and duplicate JSON/JSONC choices require selection", async (t) => {
  const configDir = await temporary(t)
  await writeFile(path.join(configDir, "tui.json"), "{}")
  await writeFile(path.join(configDir, "tui.jsonc"), "{}")
  await assert.rejects(configPaths({ configDir, scopes: ["tui"] }), /Both tui.json/)
  const chosen = path.join(configDir, "tui.jsonc")
  assert.equal((await configPaths({ configDir, tuiConfig: chosen, scopes: ["tui"] })).tui, chosen)
})

test("an existing standalone stopwatch registration and options are preserved", async (t) => {
  const configDir = await temporary(t)
  const file = path.join(configDir, "tui.json")
  const original = JSON.stringify({ plugin: [["./tool-stopwatch/tui.js", { refreshMs: 500, showInputs: false }]] }, null, 2)
  await writeFile(file, original)
  const result = await installCollection({ configDir, names: ["tool-stopwatch"], dependencyInstaller: () => { throw new Error("unexpected npm") } })
  assert.equal(result.backups.length, 0)
  assert.equal(await readFile(file, "utf8"), original)
  const runtime = await readFile(path.join(configDir, "tool-stopwatch", "tui.js"), "utf8")
  assert.ok(runtime.includes('id: "local:tool-stopwatch"'))
  assert.ok(runtime.includes('"local:tool-stopwatch:visible"'))
  assert.equal(JSON.parse(await readFile(path.join(configDir, "tool-stopwatch", "package.json"), "utf8")).name, "opencode-tool-stopwatch")
})

test("upgrading the collection keeps an absolute standalone entry without duplicating it", async (t) => {
  const configDir = await temporary(t)
  const file = path.join(configDir, "tui.json")
  const existing = [pathToFileURL(path.join(configDir, "tool-stopwatch", "tui.js")).href, { keepCompletedSeconds: 10 }]
  await writeFile(file, JSON.stringify({ plugin: ["./cache-countdown/tui.js", "./session-usage/tui.js", existing] }))
  await installCollection({ configDir, dependencyInstaller: async () => {} })
  const contents = JSON.parse(await readFile(file, "utf8"))
  assert.equal(contents.plugin.length, 3)
  assert.deepEqual(contents.plugin[2], existing)
  await installCollection({ configDir, dependencyInstaller: async () => {} })
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), contents)
})
