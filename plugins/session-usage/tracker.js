import { normalizeUsage, totalTokens, UsageLedger } from "./usage.js"

function data(result) {
  if (result?.error) throw new Error("OpenCode session API returned an error")
  return result?.data
}

export function createTracker(client, onChange = () => {}, { now = Date.now } = {}) {
  const ledger = new UsageLedger()
  const history = new Map()
  const pending = new Map()
  const liveStarts = new Map()

  async function refresh(sessionID, visited = new Set()) {
    if (visited.has(sessionID)) return
    visited.add(sessionID)
    if (pending.has(sessionID)) return pending.get(sessionID)
    const operation = (async () => {
      history.set(sessionID, "loading")
      onChange()
      const beforeRevision = ledger.revision
      try {
        const [session, rows, children] = await Promise.all([
          client.session.get({ sessionID }).then(data),
          client.session.messages({ sessionID }).then(data),
          client.session.children({ sessionID }).then(data),
        ])
        if (!session?.id || !Array.isArray(rows) || !Array.isArray(children)) throw new Error("Unexpected session API response")
        ledger.session(session)
        for (const row of rows) ledger.observeRow(row, beforeRevision)
        for (const child of children) ledger.session(child)
        history.set(sessionID, "complete")
        await Promise.all(children.map((child) => refresh(child.id, new Set(visited))))
      } catch (error) {
        history.set(sessionID, error instanceof Error ? error.message : String(error))
      } finally {
        onChange()
      }
    })()
    pending.set(sessionID, operation)
    try {
      await operation
    } finally {
      if (pending.get(sessionID) === operation) pending.delete(sessionID)
    }
  }

  function event(event) {
    const props = event.properties ?? {}
    let changed = false
    if (event.type === "session.created" || event.type === "session.updated") changed = ledger.session(props.info)
    if (event.type === "session.deleted") changed = ledger.session({ ...props.info, deleted: true })
    if (event.type === "message.updated") {
      const info = props.info
      changed = ledger.observeMessage(info)
      if (info?.role === "assistant") {
        const key = JSON.stringify([info.sessionID, info.id])
        if (info.time?.completed) liveStarts.delete(key)
        else if (!info.finish && !info.error && totalTokens(normalizeUsage(info)) === 0 && !liveStarts.has(key)
          && !ledger.sessions.get(info.sessionID)?.messages.get(info.id)?.answerReceipt) liveStarts.set(key, now())
      }
    }
    if (event.type === "message.part.updated") {
      const part = props.part
      changed = ledger.observePart(part)
      if (part?.type === "text" && typeof part.text === "string" && part.text.length) {
        changed = answerReceived(part.sessionID, part.messageID, part.id) || changed
      }
    }
    if (event.type === "message.part.delta" && props.field === "text" && typeof props.delta === "string" && props.delta.length) {
      changed = answerReceived(props.sessionID, props.messageID, props.partID)
    }
    if (event.type === "message.removed") changed = ledger.removeMessage(props.sessionID, props.messageID)
    // Part removal deliberately does not subtract already-incurred usage.
    if (changed) onChange()
    return changed
  }

  function answerReceived(sessionID, messageID, partID) {
    const key = JSON.stringify([sessionID, messageID])
    const startedAt = liveStarts.get(key)
    if (startedAt === undefined) return false
    const changed = ledger.observeAnswerReceipt(sessionID, messageID, partID, startedAt, now())
    if (changed) liveStarts.delete(key)
    return changed
  }

  return { ledger, history, refresh, event }
}
