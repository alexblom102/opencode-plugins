export const timestamp = (value) => Number.isSafeInteger(value) && value > 0 ? value : null

export function validAnswerReceipt(value) {
  return typeof value?.partID === "string" && timestamp(value.startedAt) !== null
    && timestamp(value.receivedAt) !== null && value.receivedAt >= value.startedAt
}

export function answerTiming(message) {
  const receipt = message.answerReceipt
  if (validAnswerReceipt(receipt)) {
    return { firstAnswerLatencyMs: receipt.receivedAt - receipt.startedAt,
      firstAnswerReceivedAt: receipt.receivedAt, firstAnswerTimingSource: "live-token" }
  }
  const startedAt = timestamp(message.createdAt)
  const completedAt = timestamp(message.completedAt)
  const answers = [...(message.outputStarts?.values() ?? [])]
    .filter((part) => part.type === "text" && startedAt !== null && timestamp(part.startedAt) !== null
      && part.startedAt >= startedAt && (completedAt === null || part.startedAt <= completedAt))
  const firstAnswerAt = answers.reduce((first, part) => first === null ? part.startedAt : Math.min(first, part.startedAt), null)
  return { firstAnswerLatencyMs: firstAnswerAt === null ? null : firstAnswerAt - startedAt,
    firstAnswerReceivedAt: null, firstAnswerTimingSource: firstAnswerAt === null ? null : "stored-text-start" }
}

export function summarize(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  const size = sorted.length
  const middle = Math.floor(size / 2)
  return {
    samples: size,
    average: size ? sorted.reduce((sum, value) => sum + value, 0) / size : null,
    median: size ? size % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    p95: size ? sorted[Math.ceil(size * 0.95) - 1] : null,
    min: size ? sorted[0] : null,
    max: size ? sorted[size - 1] : null,
  }
}

function mergeIntervals(intervals) {
  const merged = []
  for (const [start, end] of intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0])) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

const intervalDuration = (intervals) => intervals.reduce((sum, [start, end]) => sum + end - start, 0)

function overlappingDuration(left, right) {
  let total = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    total += Math.max(0, Math.min(left[i][1], right[j][1]) - Math.max(left[i][0], right[j][0]))
    if (left[i][1] < right[j][1]) i++
    else j++
  }
  return total
}

export function generationTiming(message, startedAt, completedAt) {
  const unknown = { modelDurationMs: null, modelCompletedAt: null, toolDurationMs: null, modelTimingSource: null }
  if (startedAt === null || completedAt === null || completedAt <= startedAt || message.timingKnown === false) return unknown
  const tools = [...(message.toolTimes?.values() ?? [])]
  // An untimed tool cannot safely be treated as zero-duration tool work.
  if (tools.some((tool) => timestamp(tool.startAt) === null || timestamp(tool.endAt) === null || tool.endAt < tool.startAt)) return unknown
  const outputs = [...(message.outputStarts?.values() ?? [])]
    .filter((part) => timestamp(part.startedAt) !== null && timestamp(part.endAt) !== null
      && part.endAt >= part.startedAt && part.startedAt >= startedAt && part.endAt <= completedAt)
  const boundaries = [...outputs.map((part) => part.endAt), ...tools.map((tool) => tool.startAt)]
    .filter((time) => time > startedAt && time <= completedAt)
  // Tool invocation starts after its arguments have been generated. Ending at
  // the last model-output boundary also excludes a trailing tool's entire wait.
  const modelCompletedAt = boundaries.reduce((last, time) => Math.max(last, time), startedAt) || startedAt
  const end = boundaries.length ? modelCompletedAt : completedAt
  const toolIntervals = mergeIntervals(tools.map((tool) => [Math.max(startedAt, tool.startAt), Math.min(completedAt, tool.endAt)]))
  const blocked = mergeIntervals(toolIntervals.map(([start, finish]) => [start, Math.min(end, finish)]))
  const generating = mergeIntervals(outputs.map((part) => [part.startedAt, part.endAt]))
  // Parallel tools overlap: subtract their union once. Preserve recorded
  // text/reasoning generation that occurred concurrently with a running tool.
  const modelDurationMs = end - startedAt - intervalDuration(blocked) + overlappingDuration(blocked, generating)
  return { modelDurationMs: modelDurationMs > 0 ? modelDurationMs : null, modelCompletedAt: end,
    toolDurationMs: intervalDuration(toolIntervals), modelTimingSource: boundaries.length ? "output/tool-boundaries" : "response-timestamps" }
}

// A message can contain several usage steps. Its timestamps describe ONE
// assistant response, so its latency must never be counted once per step.
export function responseTiming(message, entries) {
  const startedAt = timestamp(message.createdAt)
  const completedAt = timestamp(message.completedAt)
  const durationMs = startedAt !== null && completedAt !== null && completedAt > startedAt
    ? completedAt - startedAt : null
  const outputStarts = [...(message.outputStarts?.values() ?? [])].map((part) => part.startedAt)
    .filter((value) => timestamp(value) !== null && durationMs !== null && value >= startedAt && value <= completedAt)
  const firstOutputAt = outputStarts.length ? Math.min(...outputStarts) : null
  const completeCounters = entries.every(({ usage }) => usage.output !== null && usage.reasoning !== null)
  const generated = entries.reduce((sum, { usage }) => sum + (usage.output ?? 0) + (usage.reasoning ?? 0), 0)
  const generatedTokens = completeCounters && Number.isSafeInteger(generated) ? generated : null
  const generation = generationTiming(message, startedAt, completedAt)
  return {
    startedAt,
    completedAt,
    durationMs,
    firstOutputAt,
    firstOutputLatencyMs: firstOutputAt === null ? null : firstOutputAt - startedAt,
    ...answerTiming(message),
    generatedTokens,
    ...generation,
    tokensPerSecond: generation.modelDurationMs === null || generatedTokens === null ? null : generatedTokens * 1000 / generation.modelDurationMs,
  }
}

export function summarizePerformance(responses) {
  const timed = responses.filter((response) => response.durationMs !== null)
  const throughput = timed.filter((response) => response.tokensPerSecond !== null)
  const generatedTokens = throughput.reduce((sum, response) => sum + response.generatedTokens, 0)
  const durationMs = throughput.reduce((sum, response) => sum + response.modelDurationMs, 0)
  const latest = timed.reduce((last, response) => !last || response.completedAt > last.completedAt
    || (response.completedAt === last.completedAt && response.startedAt > last.startedAt) ? response : last, null)
  return {
    responses: responses.length,
    timedResponses: timed.length,
    missingTimingResponses: responses.length - timed.length,
    throughputResponses: throughput.length,
    generatedTokens,
    durationMs,
    modelDurationMs: durationMs,
    toolDurationMs: timed.reduce((sum, response) => sum + (response.toolDurationMs ?? 0), 0),
    // Weight by tool-free model time; short, fast responses must not dominate.
    tokensPerSecond: durationMs > 0 ? generatedTokens * 1000 / durationMs : null,
    throughput: summarize(throughput.map((response) => response.tokensPerSecond)),
    latencyMs: summarize(timed.map((response) => response.durationMs)),
    firstOutputLatencyMs: summarize(timed.map((response) => response.firstOutputLatencyMs)),
    firstAnswerLatencyMs: summarize(timed.map((response) => response.firstAnswerLatencyMs)),
    latest,
  }
}

export function formatRate(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "--"
}

export function formatLatency(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--"
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}s`
}

export function formatTTFT(response) {
  const value = response?.firstAnswerLatencyMs
  if (typeof value !== "number" || !Number.isFinite(value)) return "--"
  const approximate = response.firstAnswerTimingSource === "stored-text-start" ? "~" : ""
  return `${approximate}${(value / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}s`
}

export function formatDistribution(stats) {
  return `avg ${formatLatency(stats.average)} | median ${formatLatency(stats.median)} | p95 ${formatLatency(stats.p95)} | min ${formatLatency(stats.min)} | max ${formatLatency(stats.max)}`
}
