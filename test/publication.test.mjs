import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { checkRepository, scanText } from "../scripts/check.mjs"

test("publication checks reject webhook credentials and personal paths, but allow synthetic fixtures", () => {
  const webhook = "https://discord.com/api/webhooks/" + "1".repeat(18) + "/" + "x".repeat(68)
  assert.throws(() => scanText(webhook, "fixture"), /webhook credential/)
  const segments = ["C:", "Users", "fixture", "settings.json"]
  for (const separator of ["/", String.fromCharCode(92)]) {
    assert.throws(() => scanText(segments.join(separator), "fixture"), /private user-directory/)
  }
  assert.doesNotThrow(() => scanText("https://discord.com/api/webhooks/123456789/test-token", "fixture"))
})

test("publication checks reject a private Discord settings file even without a credential", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "publication-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plugin = path.join(directory, "plugins", "discord-notify")
  await mkdir(plugin, { recursive: true })
  await writeFile(path.join(plugin, "config.json"), "{}")
  await assert.rejects(checkRepository(directory), /generated or private data file/)
})
