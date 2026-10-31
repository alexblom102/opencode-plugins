import path from "node:path"
import { fileURLToPath } from "node:url"

// JSONC-preserving editor shared with opencode-tool-stopwatch (MIT).
function parseJSONC(source) {
  const characters = source.split("")
  const tokens = []
  let index = 0
  while (index < source.length) {
    const start = index
    const char = source[index]
    if (/\s/.test(char) || char === "\uFEFF") {
      if (char === "\uFEFF") characters[index] = " "
      index++
      continue
    }
    if (source.startsWith("//", index) || source.startsWith("/*", index)) {
      if (source[index + 1] === "/") {
        while (index < source.length && source[index] !== "\n") index++
      } else {
        const end = source.indexOf("*/", index + 2)
        if (end === -1) throw new Error("Unterminated block comment in OpenCode configuration")
        index = end + 2
      }
      for (let i = start; i < index; i++) if (!/[\r\n]/.test(source[i])) characters[i] = " "
      continue
    }
    if (char === '"') {
      index++
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue }
        if (source[index++] === '"') break
      }
      tokens.push({ start, end: index, kind: "string", value: JSON.parse(source.slice(start, index)) })
      continue
    }
    if ("{}[]:,".includes(char)) {
      tokens.push({ start, end: ++index, kind: "punctuation", value: char })
      continue
    }
    while (index < source.length && !/[\s{}\[\]:,]/.test(source[index]) && !source.startsWith("//", index) && !source.startsWith("/*", index)) index++
    tokens.push({ start, end: index, kind: "literal", value: source.slice(start, index) })
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "punctuation" && tokens[i].value === "," &&
      tokens[i + 1]?.kind === "punctuation" && ["]", "}"].includes(tokens[i + 1].value)) characters[tokens[i].start] = " "
  }
  return { tokens, value: JSON.parse(characters.join("")) }
}

function punctuation(token, value) {
  return token?.kind === "punctuation" && token.value === value
}

function isOpen(token) { return punctuation(token, "{") || punctuation(token, "[") }
function isClose(token) { return punctuation(token, "}") || punctuation(token, "]") }

function closingToken(tokens, open) {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (isOpen(tokens[i])) depth++
    if (isClose(tokens[i]) && --depth === 0) return i
  }
  throw new Error("Unclosed configuration object")
}

function specPath(spec, configFile) {
  try {
    if (spec.startsWith("file:")) return path.resolve(fileURLToPath(spec))
    if (spec.startsWith(".") || path.isAbsolute(spec)) return path.resolve(path.dirname(configFile), spec)
  } catch {}
}

function samePath(left, right) {
  if (!left || !right) return false
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function editConfig(source, { configFile, sourceFile, pluginSpec, schemaURL } = {}) {
  if (!configFile) throw new Error("A configuration file path is required")
  if (source === undefined) return JSON.stringify({ $schema: schemaURL, plugin: [pluginSpec] }, null, 2) + "\n"
  const { tokens, value: config } = parseJSONC(source)
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("OpenCode configuration must be an object")
  const hasPlugin = Object.hasOwn(config, "plugin")
  if (hasPlugin && (!Array.isArray(config.plugin) || config.plugin.some((entry) => typeof entry !== "string" &&
    !(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]))))) {
    throw new Error("Existing plugin configuration must be an array of strings or [path, options] pairs")
  }

  let pluginOpen
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (depth === 1 && tokens[i].kind === "string" && tokens[i].value === "plugin" && punctuation(tokens[i + 1], ":")) pluginOpen = i + 2
    if (isOpen(tokens[i])) depth++
    if (isClose(tokens[i])) depth--
  }
  if (hasPlugin) {
    const destination = specPath(pluginSpec, configFile)
    const specs = config.plugin.map((entry) => Array.isArray(entry) ? entry[0] : entry)
    if (specs.some((spec) => spec === pluginSpec || samePath(specPath(spec, configFile), destination))) return source
    const previous = specs.findIndex((spec) => samePath(specPath(spec, configFile), sourceFile))
    if (previous !== -1) {
      // Migrate a direct checkout registration to the installed copy, keeping
      // any existing tuple options exactly as authored.
      let level = 0
      let entryIndex = -1
      for (let i = pluginOpen + 1; i < closingToken(tokens, pluginOpen); i++) {
        const token = tokens[i]
        if (level === 0 && !punctuation(token, ",")) {
          entryIndex++
          if (entryIndex === previous) {
            const specToken = token.kind === "string" ? token : tokens[i + 1]
            return source.slice(0, specToken.start) + JSON.stringify(pluginSpec) + source.slice(specToken.end)
          }
        }
        if (isOpen(token)) level++
        if (isClose(token)) level--
      }
    }
  }

  const open = hasPlugin ? pluginOpen : 0
  const close = closingToken(tokens, open)
  const previous = tokens[close - 1]
  const empty = close === open + 1
  const trailing = punctuation(previous, ",")
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const indent = source.match(/\n([\t ]+)"/)?.[1] ?? "  "
  const closeLine = source.lastIndexOf("\n", tokens[close].start - 1) + 1
  const ownLine = source.slice(closeLine, tokens[close].start).trim() === ""
  const text = hasPlugin ? JSON.stringify(pluginSpec) : `"plugin": [${JSON.stringify(pluginSpec)}]`
  const edits = []
  if (ownLine && !empty && !trailing) edits.push({ start: previous.end, text: "," })
  edits.push(ownLine
    ? { start: closeLine, text: source.slice(closeLine, tokens[close].start) + indent + text + (trailing ? "," : "") + newline }
    : { start: tokens[close].start, text: (empty ? "" : trailing ? " " : ", ") + text + (trailing ? "," : "") })
  let result = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.start)
  parseJSONC(result)
  return result
}
