import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { spawnSync } from "node:child_process"
import { editConfig } from "./lib/config.mjs"

const source = path.dirname(fileURLToPath(import.meta.url))
export const plugins = {
  "cache-countdown": { scope: "tui", entry: "tui.js", files: ["tui.js", "cache.js"] },
  "session-usage": { scope: "tui", entry: "tui.js", files: ["tui.js", "usage.js", "performance.js", "pricing.js", "tracker.js"] },
  "message-timestamps": { scope: "server", entry: "server.js", files: ["server.js", "timestamps.js"], dependencies: true },
}

async function exists(file) {
  try { await access(file); return true } catch (error) { if (error.code === "ENOENT") return false; throw error }
}

export async function configPaths({ configDir, tuiConfig, serverConfig, scopes = ["tui", "server"], env = process.env } = {}) {
  const directory = path.resolve(configDir ?? env.OPENCODE_CONFIG_DIR ?? path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode"))
  const result = {}
  for (const scope of scopes) {
    const explicit = scope === "tui" ? tuiConfig ?? (configDir ? undefined : env.OPENCODE_TUI_CONFIG) : serverConfig ?? (configDir ? undefined : env.OPENCODE_CONFIG)
    if (explicit) { result[scope] = path.resolve(explicit); continue }
    const name = scope === "tui" ? "tui" : "opencode"
    const json = path.join(directory, `${name}.json`)
    const jsonc = `${json}c`
    if (await exists(json) && await exists(jsonc)) throw new Error(`Both ${name}.json and ${name}.jsonc exist. Use --${scope}-config <path>.`)
    result[scope] = await exists(jsonc) ? jsonc : json
  }
  return result
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temporary, contents, { flag: "wx", mode: 0o600 }); await rename(temporary, file) }
  finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error }) }
}

export async function installDependencies(directory) {
  const arguments_ = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm " + arguments_.join(" ")], { cwd: directory, stdio: "inherit" })
    : spawnSync("npm", arguments_, { cwd: directory, stdio: "inherit" })
  if (result.error || result.status !== 0) throw new Error("Could not install the timestamp plugin's SDK dependency. Check that npm is available, then run the installer again.")
}

export async function installCollection({ names = Object.keys(plugins), dependencyInstaller = installDependencies, ...options } = {}) {
  names = [...new Set(names)]
  if (!names.length || names.some((name) => !Object.hasOwn(plugins, name))) throw new Error(`Choose plugins from: ${Object.keys(plugins).join(", ")}`)
  const scopes = [...new Set(names.map((name) => plugins[name].scope))]
  const paths = await configPaths({ ...options, scopes })
  if (scopes.length > 1 && paths.tui === paths.server) throw new Error("TUI and server plugins need separate configuration files")
  const plans = {}
  for (const scope of scopes) {
    const file = paths[scope]
    const contents = await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error })
    plans[scope] = { file, original: contents, contents }
  }
  const payloads = []
  for (const name of names) {
    const plugin = plugins[name]
    const plan = plans[plugin.scope]
    plan.contents = editConfig(plan.contents, {
      configFile: plan.file, pluginSpec: `./${name}/${plugin.entry}`,
      sourceFile: path.join(source, "plugins", name, plugin.entry),
      schemaURL: `https://opencode.ai/${plugin.scope === "tui" ? "tui" : "config"}.json`,
    })
    const files = await Promise.all([...plugin.files, "package.json"].map(async (file) => [file, await readFile(path.join(source, "plugins", name, file))]))
    payloads.push({ name, plugin, directory: path.join(path.dirname(plan.file), name), files })
  }
  for (const payload of payloads) {
    await mkdir(payload.directory, { recursive: true })
    for (const [file, contents] of payload.files) await atomicWrite(path.join(payload.directory, file), contents)
    if (payload.plugin.dependencies) await dependencyInstaller(payload.directory)
  }
  const backups = []
  for (const plan of Object.values(plans)) {
    if (plan.contents === plan.original) continue
    if (plan.original !== undefined) {
      const backup = `${plan.file}.before-plugins-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
      await writeFile(backup, plan.original, { flag: "wx", mode: 0o600 })
      backups.push(backup)
    }
    await atomicWrite(plan.file, plan.contents)
  }
  return { plugins: payloads.map(({ name, directory }) => ({ name, directory })), configs: paths, backups }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      "config-dir": { type: "string" }, "tui-config": { type: "string" }, "server-config": { type: "string" }, help: { type: "boolean", short: "h" },
    } })
    if (values.help) console.log(`Usage: node install.mjs [${Object.keys(plugins).join(" | ")}] [--config-dir <directory>] [--tui-config <file>] [--server-config <file>]\n\nWith no plugin names, installs all three. Run again after git pull to update.`)
    else {
      const result = await installCollection({ names: positionals.length ? positionals : undefined,
        configDir: values["config-dir"], tuiConfig: values["tui-config"], serverConfig: values["server-config"] })
      for (const plugin of result.plugins) console.log(`Installed ${plugin.name}: ${plugin.directory}`)
      for (const backup of result.backups) console.log(`Previous configuration saved: ${backup}`)
      console.log("Quit and restart OpenCode. If you installed message-timestamps, restart any separately running OpenCode server too.")
    }
  } catch (error) { console.error(`Installation failed: ${error.message}`); process.exitCode = 1 }
}
