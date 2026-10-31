import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skipped = new Set([".git", "node_modules"])
const checks = [
  ["private user-directory path", /\b[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings)[\\/]{1,2}[^\\/\s"']+|\/(?:Users|home)\/[A-Za-z0-9._-]+\//i],
  ["credential-shaped token", /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Discord webhook credential", /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{50,}/i],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
]

export function scanText(text, file) {
  for (const [reason, pattern] of checks) if (pattern.test(text)) throw new Error(`${file}: ${reason} requires review`)
}

export async function filesUnder(directory = root, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue
    const relative = prefix + entry.name
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative + "/"))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`${relative}: links or special files are not distributable`)
  }
  return files.sort()
}

function reviewedSources(files) {
  return files.filter((file) => file.startsWith("plugins/") && (/\.(?:js|mjs)$/.test(file) || file.endsWith("/config.example.json")))
}

export async function updateManifest(directory = root) {
  const files = []
  for (const file of reviewedSources(await filesUnder(directory))) {
    const bytes = await readFile(path.join(directory, file))
    files.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") })
  }
  await writeFile(path.join(directory, "source-manifest.json"), JSON.stringify({
    version: 1, source: "reviewed-plugin-modules-and-synthetic-tests", files,
  }, null, 2) + "\n")
}

export async function checkRepository(directory = root) {
  const files = await filesUnder(directory)
  let syntax = 0
  for (const file of files) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|config\.json|opencode\.jsonc?|tui\.jsonc?|pricing-cache\.json|.*\.(?:db|sqlite|log|bak))$/.test(file)) throw new Error(`${file}: generated or private data file`)
    scanText(await readFile(path.join(directory, file), "utf8"), file)
    if (/\.(?:js|mjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ["--check", path.join(directory, file)], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.error}`)
      syntax++
    }
  }
  const manifest = JSON.parse(await readFile(path.join(directory, "source-manifest.json"), "utf8"))
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(directory, entry.path))
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`${entry.path}: reviewed source digest does not match`)
  }
  const reviewed = new Set(manifest.files.map((entry) => entry.path))
  for (const file of reviewedSources(files)) if (!reviewed.has(file)) throw new Error(`${file}: source is missing from the review manifest`)
  return { files: files.length, syntax }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.includes("--update-manifest")) await updateManifest()
    console.log(`Publication checks passed: ${JSON.stringify(await checkRepository())}`)
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
