const metadataKey = "local_message_timestamps"

function formatTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return
  const pad = (number) => String(number).padStart(2, "0")
  const offset = -date.getTimezoneOffset()
  const zone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
}

function visibleText(part) {
  return part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0
}

function originalText(part) {
  const stamp = part.metadata?.[metadataKey]
  if (stamp?.version === 1 && typeof stamp.prefix === "string" && part.text.startsWith(stamp.prefix)) {
    return part.text.slice(stamp.prefix.length)
  }
  return part.text
}

function stampedPart(part, label, timestamp) {
  const time = formatTime(timestamp)
  if (!time) return
  const prefix = `[${label}: ${time}]\n\n`
  const text = prefix + originalText(part)
  if (text === part.text && part.metadata?.[metadataKey]?.prefix === prefix) return
  return {
    ...part,
    text,
    metadata: { ...part.metadata, [metadataKey]: { version: 1, prefix } },
  }
}

function completedAnswer(message) {
  return message.role === "assistant" &&
    !message.summary && !message.error && message.structured === undefined &&
    typeof message.finish === "string" &&
    !["tool-calls", "unknown", "error"].includes(message.finish) &&
    formatTime(message.time?.completed) !== undefined
}

// Transport is injected so message-selection behavior can be verified without
// running a model. server.js supplies OpenCode's authenticated SDK transport.
export function createHooks(client, logError = async () => {}) {
  const pending = new Map()
  let disposed = false

  async function stampAnswer(message) {
    const { data } = await client.session.message({
      sessionID: message.sessionID,
      messageID: message.id,
    }, { throwOnError: true })
    if (disposed || !data || !completedAnswer(data.info)) return
    // Some providers report "stop" on a tool step. Such a step is still an
    // intermediate response, even if its finish reason looks terminal.
    if (data.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted)) return
    const part = data.parts.findLast(visibleText)
    if (!part) return
    const updated = stampedPart(part, "Answered", data.info.time.completed)
    if (!updated) return
    await client.part.update({
      sessionID: message.sessionID,
      messageID: message.id,
      partID: part.id,
      part: updated,
    }, { throwOnError: true })
  }

  return {
    async "chat.message"(_input, output) {
      if (disposed || output.message.role !== "user") return
      if (output.parts.some((part) => ["compaction", "subtask"].includes(part.type))) return
      const index = output.parts.findIndex(visibleText)
      if (index === -1) return
      const updated = stampedPart(output.parts[index], "Asked", output.message.time.created)
      if (updated) output.parts[index] = updated
    },

    async event({ event }) {
      if (disposed || event.type !== "message.updated") return
      const message = event.properties.info
      if (!completedAnswer(message)) return
      const key = `${message.sessionID}/${message.id}`
      if (pending.has(key)) return pending.get(key)
      const task = stampAnswer(message)
        .catch(async (error) => {
          // OpenCode dispatches event hooks without awaiting them. Always handle
          // failures here, including a failure to write the diagnostic itself.
          try { await logError(error) } catch {}
        })
        .finally(() => pending.delete(key))
      pending.set(key, task)
      return task
    },

    async "experimental.chat.messages.transform"(_input, output) {
      // Keep presentation timestamps out of subsequent model requests, including
      // signed assistant history. Saved messages and exports retain the labels.
      for (const row of output.messages) {
        row.parts = row.parts.map((part) => {
          if (part.type !== "text" || !part.metadata?.[metadataKey]) return part
          const metadata = { ...part.metadata }
          delete metadata[metadataKey]
          return { ...part, text: originalText(part), metadata }
        })
      }
    },

    async dispose() {
      disposed = true
      await Promise.allSettled([...pending.values()])
    },
  }
}
