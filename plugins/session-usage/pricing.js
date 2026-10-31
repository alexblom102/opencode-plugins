import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

export const catalogURL = "https://models.dev/api.json"
export const defaultRefreshMs = 24 * 60 * 60 * 1000
const maxCatalogBytes = 16 * 1024 * 1024
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined

// Subscription catalogs carry $0 accounting rates. API equivalence uses the
// corresponding pay-as-you-go provider, preserving region/provider identity.
export const providerPeers = {
  "zai-coding-plan": "zai",
  "zhipuai-coding-plan": "zhipuai",
  "xiaomi-token-plan-cn": "xiaomi",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-sgp": "xiaomi",
}

// Startup/offline fallback. Once loaded, the independent live catalog supplies
// all providers, including OpenAI. Max is reasoning effort, not a new tariff.
export const publishedPrices = {
  "openai/gpt-6.1-sol": {
    input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    tiers: [{ aboveInputTokens: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    mode: "Standard",
    reference: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    verifiedAt: "2026-10-13",
  },
}

export function normalizeCost(cost) {
  if (!record(cost)) return undefined
  const flatten = (item) => ({
    input: rate(item.input),
    output: rate(item.output),
    reasoning: rate(item.reasoning),
    cacheRead: rate(item.cacheRead ?? item.cache_read ?? item.cache?.read),
    cacheWrite: rate(item.cacheWrite ?? item.cache_write ?? item.cache?.write),
  })
  const base = flatten(cost)
  if (base.input === undefined || base.output === undefined) return undefined
  const tiers = (Array.isArray(cost.tiers) ? cost.tiers : [])
    .filter((item) => record(item) && (item.tier?.type === "context" || item.aboveInputTokens !== undefined))
    .map((item) => ({ ...flatten(item), aboveInputTokens: item.aboveInputTokens ?? item.tier.size }))
    .filter((item) => Number.isSafeInteger(item.aboveInputTokens) && item.aboveInputTokens >= 0
      && item.input !== undefined && item.output !== undefined)
  const legacy = cost.context_over_200k ?? cost.experimentalOver200K
  if (!tiers.length && record(legacy)) {
    const prices = flatten(legacy)
    if (prices.input !== undefined && prices.output !== undefined) tiers.push({ ...prices, aboveInputTokens: 200_000 })
  }
  return { ...base, tiers }
}

export function parseCatalog(data, { source = catalogURL, fetchedAt = Date.now() } = {}) {
  if (!record(data)) throw new Error("Invalid pricing catalog")
  const entries = Object.create(null)
  const providers = Object.create(null)
  for (const [providerID, provider] of Object.entries(data)) {
    if (!record(provider) || !record(provider.models)) continue
    providers[providerID] = {
      name: typeof provider.name === "string" ? provider.name : providerID,
      api: typeof provider.api === "string" ? provider.api : undefined,
    }
    for (const [modelID, model] of Object.entries(provider.models)) {
      const prices = normalizeCost(model?.cost)
      if (!prices) continue
      entries[`${providerID}/${modelID}`] = {
        ...prices,
        providerID,
        modelID,
        modelName: typeof model.name === "string" ? model.name : modelID,
        mode: "Standard",
        source: "models.dev",
        reference: source,
        fetchedAt,
      }
    }
  }
  const modelCount = Object.keys(entries).length
  if (!modelCount) throw new Error("Pricing catalog contains no token rate cards")
  return { version: 1, source, fetchedAt, modelCount, providers, entries }
}

export function validCatalog(snapshot, source = catalogURL) {
  if (snapshot?.version !== 1 || snapshot.source !== source || !Number.isFinite(snapshot.fetchedAt)
    || snapshot.fetchedAt < 0 || !record(snapshot.providers) || !record(snapshot.entries)) return false
  const entries = Object.entries(snapshot.entries)
  return entries.length > 0 && entries.every(([key, value]) => record(value)
    && key === `${value.providerID}/${value.modelID}`
    && typeof value.providerID === "string" && typeof value.modelID === "string"
    && rate(value.input) !== undefined && rate(value.output) !== undefined
    && ["reasoning", "cacheRead", "cacheWrite"].every((field) => value[field] === undefined || rate(value[field]) !== undefined)
    && Array.isArray(value.tiers) && value.tiers.every((tier) => Number.isSafeInteger(tier.aboveInputTokens)
      && tier.aboveInputTokens >= 0 && rate(tier.input) !== undefined && rate(tier.output) !== undefined
      && ["reasoning", "cacheRead", "cacheWrite"].every((field) => tier[field] === undefined || rate(tier[field]) !== undefined)))
}

function endpoint(value) {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return undefined
    return { origin: url.origin, pathname: url.pathname.replace(/\/+$/, "") }
  } catch {
    return undefined
  }
}

function providerForEndpoint(catalog, baseURL) {
  const target = endpoint(baseURL)
  if (!target) return undefined
  const matches = []
  for (const [id, provider] of Object.entries(catalog?.providers ?? {})) {
    const api = endpoint(provider.api)
    if (!api || api.origin !== target.origin) continue
    if (target.pathname !== api.pathname && !target.pathname.startsWith(`${api.pathname}/`)) continue
    matches.push({ id, specificity: api.pathname.length })
  }
  matches.sort((left, right) => right.specificity - left.specificity)
  if (!matches.length || (matches[1] && matches[1].specificity === matches[0].specificity)) return undefined
  return matches[0].id
}

export function lookupCatalog(catalog, providers, providerID, modelID, { providerAliases = {}, modelAliases = {} } = {}) {
  if (!catalog) return undefined
  const provider = providers.find((item) => item.id === providerID)
  const model = provider?.models?.[modelID]
  const explicit = own(modelAliases, `${providerID}/${modelID}`)
  if (typeof explicit === "string") return own(catalog.entries, explicit)
  let pricingProvider = own(providerAliases, providerID) ?? own(providerPeers, providerID) ?? providerID
  // Only infer a custom provider from a unique, exact API endpoint match.
  // Matching by model name alone would mix vendor and reseller tariffs.
  if (!own(catalog.providers, pricingProvider)) {
    const matched = providerForEndpoint(catalog, provider?.options?.baseURL ?? model?.api?.url)
    pricingProvider = own(providerPeers, matched) ?? matched
  }
  if (typeof pricingProvider !== "string") return undefined
  const ids = [...new Set([model?.api?.id, modelID].filter((id) => typeof id === "string" && id.length > 0))]
  for (const id of ids) {
    const price = own(catalog.entries, `${pricingProvider}/${id}`)
    if (price) return price
  }
  return undefined
}

export function createPriceCatalog({ cachePath, source = catalogURL, refreshMs = defaultRefreshMs,
  fetcher = globalThis.fetch, now = Date.now, onUpdate = () => {}, timeoutMs = 10_000 } = {}) {
  let catalog
  let pending
  let startup
  let controller
  let disposed = false
  let lastError

  const fresh = () => catalog && now() >= catalog.fetchedAt && now() - catalog.fetchedAt < refreshMs
  const apply = (value) => {
    catalog = value
    lastError = undefined
    if (!disposed) onUpdate(value)
  }

  async function persist(value) {
    if (!cachePath || disposed) return
    await mkdir(path.dirname(cachePath), { recursive: true })
    const temporary = `${cachePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx" })
      if (disposed) return
      await rename(temporary, cachePath)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async function refresh(force = false) {
    if (disposed || (!force && fresh())) return catalog
    if (pending) return pending
    const operation = (async () => {
      controller = new AbortController()
      const timer = setTimeout(() => controller?.abort(), timeoutMs)
      timer.unref?.()
      try {
        const response = await fetcher(source, { signal: controller.signal, headers: { accept: "application/json" } })
        if (!response.ok) throw new Error(`Pricing fetch returned HTTP ${response.status}`)
        const text = await response.text()
        if (Buffer.byteLength(text) > maxCatalogBytes) throw new Error("Pricing catalog is too large")
        const next = parseCatalog(JSON.parse(text), { source, fetchedAt: now() })
        if (!disposed) {
          apply(next)
          await persist(next)
        }
      } catch (error) {
        if (!disposed) lastError = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(timer)
        controller = undefined
      }
      return catalog
    })()
    pending = operation
    try {
      return await operation
    } finally {
      if (pending === operation) pending = undefined
    }
  }

  function start() {
    if (startup) return startup
    startup = (async () => {
      if (cachePath) {
        try {
          const text = await readFile(cachePath, "utf8")
          if (Buffer.byteLength(text) > maxCatalogBytes) throw new Error("Pricing cache is too large")
          const saved = JSON.parse(text)
          if (validCatalog(saved, source) && !disposed) apply(saved)
        } catch {
          // An absent/corrupt cache is rebuilt from the price feed.
        }
      }
      return refresh()
    })()
    return startup
  }

  return {
    start,
    refresh,
    get catalog() { return catalog },
    get lastError() { return lastError },
    dispose() { disposed = true; controller?.abort() },
  }
}
