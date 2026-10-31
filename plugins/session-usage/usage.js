import { lookupCatalog, normalizeCost, publishedPrices } from "./pricing.js"
import { answerTiming, formatDistribution, formatLatency, formatRate, formatTTFT, responseTiming, summarizePerformance, timestamp, validAnswerReceipt } from "./performance.js"
export { publishedPrices } from "./pricing.js"

// OpenCode's normalized counters are disjoint: input excludes cache tokens;
// output excludes reported reasoning. Provider tokens.total is not an extra category.
export const tokenFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const money = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function normalizeUsage(value) {
  const tokens = value?.tokens
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    reasoning: count(tokens?.reasoning),
    cacheRead: count(tokens?.cache?.read),
    cacheWrite: count(tokens?.cache?.write),
    cost: money(value?.cost),
  }
}

export function totalTokens(usage) {
  return tokenFields.reduce((sum, field) => sum + (usage[field] ?? 0), 0)
}

export function emptyTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function addTokens(target, usage) {
  for (const field of tokenFields) target[field] += usage[field] ?? 0
  target.total += totalTokens(usage)
}

function validUsage(value) {
  return object(value) && tokenFields.every((field) => value[field] === null || count(value[field]) !== null)
    && (value.cost === null || money(value.cost) !== null)
}

export class UsageLedger {
  constructor(saved) {
    this.sessions = new Map()
    this.revision = 0
    if (saved) this.restore(saved)
  }

  restore(saved) {
    if (saved?.version !== 1 || !Array.isArray(saved.sessions)) return false
    for (const session of saved.sessions) {
      if (typeof session?.id !== "string" || !Array.isArray(session.messages)) continue
      this.session(session)
      for (const message of session.messages) {
        if (typeof message?.id !== "string" || !Array.isArray(message.steps)) continue
        const restored = this.message(session.id, message.id)
        // Preserve newer live data while recovering older, no-longer-visible steps.
        if (restored.revision === 0) {
          restored.timingKnown = Array.isArray(message.toolTimes) && message.timingKnown !== false
          for (const key of ["providerID", "modelID", "agent", "createdAt", "completedAt", "summary", "removed"]) {
            if (typeof message[key] === "string" || typeof message[key] === "number" || typeof message[key] === "boolean") {
              restored[key] = message[key]
            }
          }
          if (validUsage(message.fallback)) restored.fallback = { ...message.fallback }
        }
        for (const step of message.steps) {
          if (typeof step?.id === "string" && validUsage(step.usage) && !restored.steps.has(step.id)) {
            restored.steps.set(step.id, { id: step.id, usage: { ...step.usage }, revision: 0 })
          }
        }
        for (const part of Array.isArray(message.outputStarts) ? message.outputStarts : []) {
          if (typeof part?.id === "string" && timestamp(part.startedAt) !== null && !restored.outputStarts.has(part.id)) {
            restored.outputStarts.set(part.id, { id: part.id, startedAt: part.startedAt,
              endAt: timestamp(part.endAt), type: part.type === "text" || part.type === "reasoning" ? part.type : undefined, revision: 0 })
          }
        }
        for (const tool of Array.isArray(message.toolTimes) ? message.toolTimes : []) {
          if (typeof tool?.id === "string" && !restored.toolTimes.has(tool.id)) {
            restored.toolTimes.set(tool.id, { id: tool.id, startAt: timestamp(tool.startAt), endAt: timestamp(tool.endAt), revision: 0 })
          }
        }
        if (!restored.answerReceipt && validAnswerReceipt(message.answerReceipt)) {
          const { partID, startedAt, receivedAt } = message.answerReceipt
          restored.answerReceipt = { partID, startedAt, receivedAt }
        }
        if (Array.isArray(message.retries)) {
          for (const id of message.retries) if (typeof id === "string") restored.retries.add(id)
        }
      }
    }
    return true
  }

  session(info) {
    if (typeof info?.id !== "string") return false
    let record = this.sessions.get(info.id)
    if (!record) {
      record = { id: info.id, messages: new Map() }
      this.sessions.set(info.id, record)
    }
    const before = [record.parentID, record.title, record.createdAt, record.deleted]
    if (typeof info.parentID === "string") record.parentID = info.parentID
    if (typeof info.title === "string") record.title = info.title
    if (count(info.time?.created ?? info.createdAt) !== null) record.createdAt = info.time?.created ?? info.createdAt
    if (info.deleted === true) record.deleted = true
    return !same(before, [record.parentID, record.title, record.createdAt, record.deleted])
  }

  message(sessionID, messageID) {
    this.session({ id: sessionID })
    const messages = this.sessions.get(sessionID).messages
    if (!messages.has(messageID)) messages.set(messageID, { id: messageID, steps: new Map(), outputStarts: new Map(), partKinds: new Map(), toolTimes: new Map(), timingKnown: true, retries: new Set(), revision: 0 })
    return messages.get(messageID)
  }

  observeMessage(info, beforeRevision = Infinity) {
    if (info?.role !== "assistant" || typeof info.id !== "string" || typeof info.sessionID !== "string") return false
    const record = this.message(info.sessionID, info.id)
    if (record.revision > beforeRevision) return false
    const metadata = {
      providerID: info.providerID,
      modelID: info.modelID,
      agent: info.agent ?? info.mode,
      createdAt: timestamp(info.time?.created) ?? record.createdAt,
      completedAt: timestamp(info.time?.completed) ?? record.completedAt,
      summary: info.summary === true,
    }
    const usage = normalizeUsage(info)
    // Pending/shell zero counters are placeholders, not new billed requests.
    const measured = totalTokens(usage) > 0 || (usage.cost ?? 0) > 0
      || Boolean(info.time?.completed && (info.finish || info.error))
    const fallback = measured ? usage : record.fallback
    const before = [record.providerID, record.modelID, record.agent, record.createdAt, record.completedAt, record.summary, record.fallback]
    const after = [metadata.providerID, metadata.modelID, metadata.agent, metadata.createdAt, metadata.completedAt, metadata.summary, fallback]
    if (same(before, after)) return false
    Object.assign(record, metadata, { fallback, revision: ++this.revision })
    return true
  }

  observePart(part, beforeRevision = Infinity) {
    if (typeof part?.sessionID !== "string" || typeof part.messageID !== "string" || typeof part.id !== "string") return false
    if (!["step-finish", "retry", "text", "reasoning", "tool"].includes(part.type)) return false
    const record = this.message(part.sessionID, part.messageID)
    if (part.type === "text" || part.type === "reasoning") {
      const previous = record.outputStarts.get(part.id)
      const kind = record.partKinds.get(part.id)
      if (previous?.revision > beforeRevision || kind?.revision > beforeRevision) return false
      const eligible = !part.synthetic && !part.ignored
      record.partKinds.set(part.id, { type: part.type, eligible, revision: this.revision })
      if (!eligible || typeof part.text !== "string" || !part.text.length || timestamp(part.time?.start) === null) return false
      const endAt = timestamp(part.time?.end) ?? previous?.endAt ?? null
      if (previous?.startedAt === part.time.start && previous?.endAt === endAt && previous?.type === part.type) return false
      // Keep only timing metadata, never response/reasoning text.
      record.outputStarts.set(part.id, { id: part.id, type: part.type, startedAt: part.time.start, endAt, revision: this.revision + 1 })
    } else if (part.type === "tool") {
      const previous = record.toolTimes.get(part.id)
      if (previous?.revision > beforeRevision) return false
      const startAt = timestamp(part.state?.time?.start) ?? previous?.startAt ?? null
      const endAt = timestamp(part.state?.time?.end) ?? previous?.endAt ?? null
      if (previous && previous.startAt === startAt && previous.endAt === endAt) return false
      record.toolTimes.set(part.id, { id: part.id, startAt, endAt, revision: this.revision + 1 })
    } else if (part.type === "retry") {
      if (record.retries.has(part.id)) return false
      record.retries.add(part.id)
    } else {
      const previous = record.steps.get(part.id)
      if (previous?.revision > beforeRevision) return false
      const usage = normalizeUsage(part)
      if (same(previous?.usage, usage)) return false
      record.steps.set(part.id, { id: part.id, usage, revision: this.revision + 1 })
    }
    record.revision = ++this.revision
    return true
  }

  observeAnswerReceipt(sessionID, messageID, partID, startedAt, receivedAt) {
    const record = this.sessions.get(sessionID)?.messages.get(messageID)
    const kind = record?.partKinds.get(partID)
    if (!record || record.answerReceipt || kind?.type !== "text" || !kind.eligible) return false
    const receipt = { partID, startedAt, receivedAt }
    if (!validAnswerReceipt(receipt)) return false
    record.answerReceipt = receipt
    record.revision = ++this.revision
    return true
  }

  observeRow(row, beforeRevision = Infinity) {
    let changed = this.observeMessage(row?.info, beforeRevision)
    // Step counters supersede the message aggregate; never sum both.
    for (const part of row?.parts ?? []) changed = this.observePart(part, beforeRevision) || changed
    if (row?.info?.role === "assistant" && Array.isArray(row.parts)) {
      const record = this.sessions.get(row.info.sessionID)?.messages.get(row.info.id)
      if (record && !record.timingKnown) {
        record.timingKnown = true
        record.revision = ++this.revision
        changed = true
      }
    }
    return changed
  }

  removeMessage(sessionID, messageID) {
    const record = this.sessions.get(sessionID)?.messages.get(messageID)
    if (!record || record.removed) return false
    record.removed = true
    record.revision = ++this.revision
    return true
  }

  sessionIDs(rootID, includeChildren = true) {
    const ids = new Set([rootID])
    if (!includeChildren) return ids
    let changed = true
    while (changed) {
      changed = false
      for (const session of this.sessions.values()) {
        if (ids.has(session.parentID) && !ids.has(session.id)) {
          ids.add(session.id)
          changed = true
        }
      }
    }
    return ids
  }

  snapshot() {
    return {
      version: 1,
      sessions: [...this.sessions.values()].map(({ messages, ...session }) => ({
        ...session,
        messages: [...messages.values()].map(({ steps, outputStarts, partKinds, toolTimes, retries, revision, ...message }) => ({
          ...message,
          steps: [...steps.values()].map(({ revision, ...step }) => step),
          outputStarts: [...outputStarts.values()].map(({ revision, ...part }) => part),
          toolTimes: [...toolTimes.values()].map(({ revision, ...tool }) => tool),
          retries: [...retries],
        })),
      })),
    }
  }
}

export function resolveRates(providers, providerID, modelID, usage, prices = {}, pricing = {}) {
  const key = `${providerID}/${modelID}`
  const custom = prices[key]
  let profile
  let source
  if (object(custom)) {
    profile = custom
    source = "configured"
  } else if (lookupCatalog(pricing.catalog, providers, providerID, modelID, pricing)) {
    profile = lookupCatalog(pricing.catalog, providers, providerID, modelID, pricing)
    source = profile.source
  } else if (publishedPrices[key]) {
    profile = publishedPrices[key]
    source = "published API prices"
  } else {
    const cost = providers.find((provider) => provider.id === providerID)?.models?.[modelID]?.cost
    if (!cost) return undefined
    // An all-zero catalog may be a subscription override. Do not display an
    // unknown API equivalent as $0. Explicit configured zero rates still work.
    if (![cost.input, cost.output, cost.cache?.read, cost.cache?.write].some((rate) => money(rate) > 0)) return undefined
    profile = normalizeCost(cost)
    if (!profile) return undefined
    source = "model catalog"
  }
  const context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const tier = (Array.isArray(profile.tiers) ? profile.tiers : [])
    .filter((item) => count(item.aboveInputTokens) !== null && context > item.aboveInputTokens)
    .sort((left, right) => right.aboveInputTokens - left.aboveInputTokens)[0]
  const selected = tier ?? profile
  return {
    input: selected.input,
    output: selected.output,
    reasoning: selected.reasoning ?? (tier ? undefined : profile.reasoning),
    cacheRead: selected.cacheRead,
    cacheWrite: selected.cacheWrite,
    inputTokens: context,
    aboveInputTokens: tier?.aboveInputTokens,
    source,
    mode: profile.mode,
    reference: profile.reference,
    verifiedAt: profile.verifiedAt,
    fetchedAt: profile.fetchedAt,
    pricingProviderID: profile.providerID ?? providerID,
    pricingModelID: profile.modelID ?? modelID,
  }
}

export function estimateCost(usage, rates) {
  let subtotal = 0
  const missing = []
  for (const field of tokenFields) {
    const tokens = usage[field]
    if (tokens === 0) continue
    const rate = money(field === "reasoning" ? rates?.reasoning ?? rates?.output : rates?.[field])
    const charge = tokens === null || rate === null ? NaN : tokens * rate / 1_000_000
    if (!Number.isFinite(charge) || !Number.isFinite(subtotal + charge)) missing.push(field)
    else subtotal += charge
  }
  return { subtotal, complete: missing.length === 0, missing }
}

export function buildReport(ledger, rootID, { includeChildren = true, providers = [], prices = {}, history = new Map(),
  catalog, providerAliases = {}, modelAliases = {} } = {}) {
  const report = {
    version: 1,
    sessionID: rootID,
    title: ledger.sessions.get(rootID)?.title ?? rootID,
    generatedAt: new Date().toISOString(),
    includeChildren,
    tokens: emptyTotals(),
    requests: 0,
    compactionRequests: 0,
    longContextRequests: 0,
    inheritedRequestsExcluded: 0,
    retryNotices: 0,
    emptyUsageRequests: 0,
    incompleteUsageRequests: 0,
    recordedCost: { usd: 0, missingRequests: 0 },
    rateCardCost: { usd: 0, unpricedRequests: 0 },
    models: [],
    providers: [],
    agents: [],
    sessions: [],
    calls: [],
    responses: [],
    latestAnswer: null,
    coverage: { historyComplete: true, historyErrors: [] },
    pricingCatalog: catalog ? { source: catalog.source, fetchedAt: catalog.fetchedAt, modelCount: catalog.modelCount } : undefined,
  }
  const models = new Map()
  const providerGroups = new Map()
  const agents = new Map()
  const performanceSamples = new Map()
  function group(map, name) {
    if (!map.has(name)) map.set(name, { name, requests: 0, tokens: emptyTotals(), recordedCostUSD: 0, apiEquivalentCostUSD: 0, unpricedRequests: 0 })
    return map.get(name)
  }
  for (const id of ledger.sessionIDs(rootID, includeChildren)) {
    const session = ledger.sessions.get(id)
    const state = history.get(id)
    if (state !== "complete" && !session?.deleted) {
      report.coverage.historyComplete = false
      report.coverage.historyErrors.push({ sessionID: id, reason: state ?? "History has not been loaded yet" })
    }
    const subtotal = { sessionID: id, title: session?.title ?? id, requests: 0, tokens: emptyTotals(), recordedCostUSD: 0, apiEquivalentCostUSD: 0, unpricedRequests: 0 }
    report.sessions.push(subtotal)
    for (const message of session?.messages.values() ?? []) {
      const entries = message.steps.size ? [...message.steps.values()] : message.fallback ? [{ id: message.id, usage: message.fallback }] : []
      // Forks can copy old assistant messages under new IDs without a model call.
      if (message.createdAt > 0 && session.createdAt > 0 && message.createdAt < session.createdAt) {
        report.inheritedRequestsExcluded += entries.length
        continue
      }
      report.retryNotices += message.retries.size
      const answer = answerTiming(message)
      if (id === rootID && !message.summary && timestamp(message.createdAt) !== null
        && (entries.length || answer.firstAnswerLatencyMs !== null || timestamp(message.completedAt) === null)
        && (!report.latestAnswer || message.createdAt > report.latestAnswer.startedAt
          || (message.createdAt === report.latestAnswer.startedAt && message.id > report.latestAnswer.messageID))) {
        report.latestAnswer = { sessionID: id, messageID: message.id, startedAt: message.createdAt, ...answer }
      }
      if (!entries.length) continue
      const model = `${message.providerID ?? "unknown"}/${message.modelID ?? "unknown"}`
      const agent = message.summary ? "compaction" : message.agent ?? "unknown"
      const targets = [report, subtotal, group(models, model), group(providerGroups, message.providerID ?? "unknown"), group(agents, agent)]
      for (const entry of entries) {
        const usage = entry.usage
        const rates = resolveRates(providers, message.providerID, message.modelID, usage, prices, { catalog, providerAliases, modelAliases })
        const estimated = { ...estimateCost(usage, rates), rates }
        report.requests++
        if (agent === "compaction") report.compactionRequests++
        if (rates?.aboveInputTokens !== undefined) report.longContextRequests++
        if (totalTokens(usage) === 0) report.emptyUsageRequests++
        if (tokenFields.some((field) => usage[field] === null)) report.incompleteUsageRequests++
        if (usage.cost === null) report.recordedCost.missingRequests++
        report.recordedCost.usd += usage.cost ?? 0
        report.rateCardCost.usd += estimated.subtotal
        if (!estimated.complete) report.rateCardCost.unpricedRequests++
        for (const target of targets) {
          addTokens(target.tokens, usage)
          if (target !== report) {
            target.requests++
            target.recordedCostUSD += usage.cost ?? 0
            target.apiEquivalentCostUSD += estimated.subtotal
            if (!estimated.complete) target.unpricedRequests++
          }
        }
        report.calls.push({ sessionID: id, messageID: message.id, usageID: entry.id, model, agent, removed: message.removed === true, usage, estimate: estimated })
      }
      const response = { sessionID: id, messageID: message.id, model, agent, removed: message.removed === true,
        usageIDs: entries.map((entry) => entry.id), ...responseTiming(message, entries) }
      report.responses.push(response)
      for (const target of targets) {
        if (!performanceSamples.has(target)) performanceSamples.set(target, [])
        performanceSamples.get(target).push(response)
      }
    }
  }
  report.models = [...models.values()].sort((left, right) => right.tokens.total - left.tokens.total)
  report.providers = [...providerGroups.values()].sort((left, right) => right.tokens.total - left.tokens.total)
  report.agents = [...agents.values()].sort((left, right) => right.tokens.total - left.tokens.total)
  for (const target of [report, ...report.sessions, ...report.models, ...report.providers, ...report.agents]) {
    target.performance = summarizePerformance(performanceSamples.get(target) ?? [])
  }
  return report
}

export const formatNumber = (value) => value.toLocaleString("en-US")
export const formatUSD = (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false })}`

export function formatStatus(report) {
  const partial = !report.coverage.historyComplete || report.incompleteUsageRequests > 0
  const unpriced = report.rateCardCost.unpricedRequests > 0
  const cost = unpriced && report.rateCardCost.usd === 0
    ? "API unpriced"
    : `API ~${formatUSD(report.rateCardCost.usd)}${unpriced ? "+" : ""}`
  return `Usage ${formatNumber(report.tokens.total)}${partial ? "+" : ""} | ${formatRate(report.performance.tokensPerSecond)} tok/s | TTFT ${formatTTFT(report.latestAnswer)} | ${cost}`
}

export function formatReport(report) {
  const t = report.tokens
  const p = report.performance
  const latest = p.latest
  const performance = (item) => `${formatRate(item.performance.tokensPerSecond)} tok/s | ${formatLatency(item.performance.latencyMs.average)}`
  const lines = [
    report.title,
    `Session: ${report.sessionID}`,
    `Scope: ${report.sessions.length} session(s), ${report.requests} reported request(s)`,
    "",
    `Input (uncached):  ${formatNumber(t.input)}`,
    `Output (non-reasoning): ${formatNumber(t.output)}`,
    `Reasoning:         ${formatNumber(t.reasoning)}`,
    `Cache read:        ${formatNumber(t.cacheRead)}`,
    `Cache write:       ${formatNumber(t.cacheWrite)}`,
    `TOTAL:             ${formatNumber(t.total)}`,
    "",
    "PERFORMANCE (assistant responses)",
    `Model throughput: ${formatRate(p.tokensPerSecond)} tok/s (reasoning + output / tool-free model time)`,
    `Measured model time: ${formatLatency(p.modelDurationMs)} | excluded tool work: ${formatLatency(p.toolDurationMs)}`,
    `Response latency: ${formatDistribution(p.latencyMs)}`,
    `Time to first answer: ${formatDistribution(p.firstAnswerLatencyMs)}`,
    `Prompt TTFT (latest response): ${formatTTFT(report.latestAnswer)}`,
    `First output latency: ${formatDistribution(p.firstOutputLatencyMs)}`,
    ...(latest ? [`Latest response: ${formatRate(latest.tokensPerSecond)} tok/s | latency ${formatLatency(latest.durationMs)} | TTFT ${formatTTFT(latest)}`] : []),
    `Timing samples: ${p.timedResponses}/${p.responses} responses | throughput ${p.throughputResponses}/${p.responses} | first answer ${p.firstAnswerLatencyMs.samples}/${p.responses}`,
    "Response time includes model setup, retries and tool execution.",
    "First output uses the first nonempty text/reasoning block's start time.",
    "TTFT includes thinking before answer text; ~ uses stored text-start timing.",
    "",
    `API equivalent: ~${formatUSD(report.rateCardCost.usd)} USD${report.rateCardCost.unpricedRequests ? "+" : ""}`,
    "Output pricing includes non-reasoning output + reasoning tokens.",
    "",
    "BY PROVIDER (requests | total tokens | API equivalent | tok/s | avg latency)",
    ...report.providers.map((item) => `${item.name}: ${item.requests} | ${formatNumber(item.tokens.total)} | ~${formatUSD(item.apiEquivalentCostUSD)}${item.unpricedRequests ? "+" : ""} | ${performance(item)}`),
    "",
    "BY MODEL (requests | total tokens | API equivalent | tok/s | avg latency)",
    ...report.models.map((item) => `${item.name}: ${item.requests} | ${formatNumber(item.tokens.total)} | ~${formatUSD(item.apiEquivalentCostUSD)}${item.unpricedRequests ? "+" : ""} | ${performance(item)}`),
    "",
    `Compaction: ${report.compactionRequests} request(s)`,
    `Long-context pricing: ${report.longContextRequests} request(s)`,
    `Subagents: ${report.sessions.slice(1).reduce((sum, item) => sum + item.requests, 0)} request(s)`,
    ...report.sessions.slice(1).map((item) => `  ${item.title}: ${formatNumber(item.tokens.total)} tokens | ~${formatUSD(item.apiEquivalentCostUSD)}${item.unpricedRequests ? "+" : ""} | ${performance(item)}`),
  ]
  const tariffs = new Map()
  for (const call of report.calls) {
    const rates = call.estimate.rates
    if (!rates) continue
    const key = JSON.stringify([call.model, rates.input, rates.output, rates.reasoning, rates.cacheRead, rates.cacheWrite, rates.aboveInputTokens])
    tariffs.set(key, { model: call.model, rates })
  }
  if (tariffs.size) lines.push("", "APPLIED RATES (USD per 1M tokens)")
  for (const { model, rates } of tariffs.values()) {
    const tier = rates.aboveInputTokens === undefined ? "base" : `>${formatNumber(rates.aboveInputTokens)} input`
    const number = (value) => value === undefined ? "-" : formatUSD(value)
    const reasoning = rates.reasoning !== undefined && rates.reasoning !== rates.output ? ` | reason ${number(rates.reasoning)}` : ""
    lines.push(`${model} (${tier}): in ${number(rates.input)} | out ${number(rates.output)}${reasoning} | read ${number(rates.cacheRead)} | write ${number(rates.cacheWrite)}`)
    const pricedModel = `${rates.pricingProviderID}/${rates.pricingModelID}`
    if (pricedModel !== model) lines.push(`  API rate card: ${pricedModel}`)
  }
  if (report.pricingCatalog) lines.push(`Prices updated: ${new Date(report.pricingCatalog.fetchedAt).toISOString().slice(0, 10)}`)
  if (report.inheritedRequestsExcluded) lines.push(`Inherited history excluded: ${report.inheritedRequestsExcluded} request(s)`)
  if (report.retryNotices) lines.push(`Retry notices: ${report.retryNotices} (not added as separate usage without counters)`)
  if (report.emptyUsageRequests) lines.push(`Requests with zero reported tokens: ${report.emptyUsageRequests}`)
  if (report.incompleteUsageRequests) lines.push(`Incomplete token counters: ${report.incompleteUsageRequests} request(s)`)
  if (report.rateCardCost.unpricedRequests) lines.push(`Unpriced requests: ${report.rateCardCost.unpricedRequests}`)
  if (!report.coverage.historyComplete) lines.push(`History loading/errors: ${report.coverage.historyErrors.length} session(s)`)
  return lines.join("\n")
}
