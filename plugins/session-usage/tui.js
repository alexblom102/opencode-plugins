import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { buildReport, formatReport, formatStatus } from "./usage.js"
import { createTracker } from "./tracker.js"
import { catalogURL, createPriceCatalog, defaultRefreshMs } from "./pricing.js"

const storageKey = "local:session-usage:v1"

export default {
  id: "local:session-usage",
  async tui(api, rawOptions = {}) {
    const includeChildren = rawOptions.includeChildren !== false
    const prices = rawOptions.prices ?? {}
    const providerAliases = rawOptions.providerAliases ?? {}
    const modelAliases = rawOptions.modelAliases ?? {}
    const [revision, setRevision] = createSignal(0)
    let restored = false
    let timer
    let disposed = false
    let persistenceError
    let pricing
    let pricesReady = Promise.resolve()

    function save() {
      if (!restored) return
      try {
        api.kv.set(storageKey, tracker.ledger.snapshot())
        persistenceError = undefined
      } catch (error) {
        persistenceError = String(error)
      }
    }

    function changed() {
      if (disposed) return
      setRevision((value) => value + 1)
      clearTimeout(timer)
      timer = setTimeout(save, 300)
      timer.unref?.()
    }

    const tracker = createTracker(api.client, changed)
    createEffect(() => {
      if (pricing || !api.state.path.state) return
      const statePath = api.state.path.state
      untrack(() => {
        const hours = rawOptions.pricingRefreshHours
        const refreshMs = typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : defaultRefreshMs
        pricing = createPriceCatalog({
          cachePath: path.join(statePath, "session-usage", "pricing-cache.json"),
          source: rawOptions.pricingURL ?? catalogURL,
          refreshMs,
          onUpdate: changed,
        })
        pricesReady = pricing.start()
        const refreshTimer = setInterval(() => { void pricing.refresh() }, Math.min(refreshMs, 3_600_000))
        refreshTimer.unref?.()
        api.lifecycle.onDispose(() => { clearInterval(refreshTimer); pricing.dispose() })
      })
    })
    createEffect(() => {
      if (restored || !api.kv.ready) return
      const saved = api.kv.get(storageKey)
      if (saved && !tracker.ledger.restore(saved)) {
        api.ui.toast({ title: "Session usage", message: "Saved usage has an unsupported format; rebuilding from session history.", variant: "warning" })
      }
      restored = true
      changed()
    })

    function currentSessionID() {
      const route = api.route.current
      return route.name === "session" ? route.params.sessionID : undefined
    }

    function report(sessionID) {
      revision()
      const result = buildReport(tracker.ledger, sessionID, {
        includeChildren, prices, providers: api.state.provider, history: tracker.history,
        catalog: pricing?.catalog, providerAliases, modelAliases,
      })
      if (persistenceError) {
        result.coverage.historyComplete = false
        result.coverage.historyErrors.push({ sessionID, reason: `Persistence failed: ${persistenceError}` })
      }
      return result
    }

    createEffect(() => {
      if (!api.state.ready) return
      const id = currentSessionID()
      if (id) untrack(() => { void tracker.refresh(id) })
    })

    // Seed live state too, so a request completed during startup is not lost.
    createEffect(() => {
      const id = currentSessionID()
      if (!id) return
      const info = api.state.session.get(id)
      const rows = api.state.session.messages(id).map((message) => ({ info: message, parts: api.state.part(message.id) }))
      untrack(() => {
        let dirty = info ? tracker.ledger.session(info) : false
        for (const row of rows) dirty = tracker.ledger.observeRow(row) || dirty
        if (dirty) changed()
      })
    })

    for (const type of ["session.created", "session.updated", "session.deleted", "message.updated", "message.part.updated", "message.part.delta", "message.removed"]) {
      const unsubscribe = api.event.on(type, (event) => {
        tracker.event(event)
        if (type === "session.created" && includeChildren) void tracker.refresh(event.properties.info.id)
      })
      api.lifecycle.onDispose(unsubscribe)
    }
    api.lifecycle.onDispose(api.event.on("server.connected", () => {
      const id = currentSessionID()
      if (id) void tracker.refresh(id)
    }))

    async function showDetails(sessionID = currentSessionID()) {
      if (!sessionID) {
        api.ui.toast({ title: "Session usage", message: "Open a session to see its token usage.", variant: "info" })
        return
      }
      await Promise.all([tracker.refresh(sessionID), pricesReady])
      if (disposed) return
      const text = formatReport(untrack(() => report(sessionID)))
      save()
      api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "Session token usage", message: text }))
      api.ui.dialog.setSize("large")
    }

    async function exportDetails() {
      const id = currentSessionID()
      if (!id) return showDetails()
      await Promise.all([tracker.refresh(id), pricesReady])
      if (disposed) return
      try {
        const outputDirectory = path.join(api.state.path.state, "session-usage", "exports")
        await mkdir(outputDirectory, { recursive: true })
        const name = `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`
        const outputPath = path.join(outputDirectory, name)
        await writeFile(outputPath, JSON.stringify(untrack(() => report(id)), null, 2) + "\n", { flag: "wx" })
        save()
        api.ui.toast({ title: "Usage report exported", message: outputPath, variant: "success", duration: 12000 })
      } catch (error) {
        api.ui.toast({ title: "Usage export failed", message: String(error), variant: "error", duration: 12000 })
      }
    }

    async function refreshPrices() {
      await pricesReady
      await pricing?.refresh(true)
      if (disposed) return
      api.ui.toast({ title: "API prices", message: pricing?.lastError
        ? `Price refresh failed: ${pricing.lastError}`
        : `Updated ${pricing?.catalog?.modelCount ?? 0} model rate cards`,
        variant: pricing?.lastError ? "error" : "success", duration: 6000 })
    }

    const unregister = api.keymap.registerLayer({
      commands: [
        { name: "session-usage.show", title: "Session usage: show statistics", desc: "Show tokens, tokens/sec, latency, subagents and cost estimates", category: "Session", namespace: "palette", slashName: "usage",
          run() { api.ui.dialog.clear(); void showDetails() } },
        { name: "session-usage.export", title: "Session usage: export JSON", desc: "Export usage, response timing and session/model/agent breakdowns", category: "Session", namespace: "palette", slashName: "usage-export",
          run() { api.ui.dialog.clear(); void exportDetails() } },
        { name: "session-usage.prices", title: "Session usage: refresh API prices", desc: "Refresh all provider/model prices from models.dev", category: "Session", namespace: "palette", slashName: "usage-prices",
          run() { api.ui.dialog.clear(); void refreshPrices() } },
      ],
    })
    if (typeof unregister === "function") api.lifecycle.onDispose(unregister)

    api.slots.register({
      order: 150,
      slots: {
        session_prompt_right(_context, props) {
          const stats = createMemo(() => report(props.session_id))
          const text = createElement("text")
          setProp(text, "onMouseDown", () => { void showDetails(props.session_id) })
          createEffect(() => setProp(text, "fg", api.theme.current.textMuted))
          insert(text, () => formatStatus(stats()))
          onCleanup(() => text.destroy())
          return text
        },
      },
    })

    api.lifecycle.onDispose(() => {
      disposed = true
      clearTimeout(timer)
      save()
    })
  },
}
