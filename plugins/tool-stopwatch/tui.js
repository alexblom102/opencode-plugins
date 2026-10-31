import { createElement, insert, setProp } from "@opentui/solid"
import { createComponent, createEffect, createMemo, createSignal, For, onCleanup } from "solid-js"
import { createTracker, parseOptions, sessionTools, visibleTimers } from "./stopwatch.js"

// UI dependencies are provided by OpenCode's TUI plugin runtime.
export default {
  id: "local:tool-stopwatch",
  async tui(api, rawOptions) {
    const options = parseOptions(rawOptions)
    const key = "local:tool-stopwatch:visible"
    const [enabled, setEnabled] = createSignal(true)
    let restored = false
    createEffect(() => {
      if (restored || !api.kv.ready) return
      restored = true
      setEnabled(api.kv.get(key, true) !== false)
    })

    const unregister = api.keymap.registerLayer({
      commands: [{
        name: "tool-stopwatch.toggle",
        title: "Tool stopwatch: toggle panel",
        desc: "Show or hide live elapsed times for the current session's tools",
        category: "Session",
        namespace: "palette",
        slashName: "tool-timers",
        run() {
          api.ui.dialog.clear()
          const next = !enabled()
          setEnabled(next)
          api.kv.set(key, next)
          api.ui.toast({ title: "Tool stopwatch", message: next ? "Timer panel enabled" : "Timer panel hidden", variant: "info" })
        },
      }],
    })
    if (typeof unregister === "function") api.lifecycle.onDispose(unregister)

    function Panel() {
      const tracker = createTracker()
      const [now, setNow] = createSignal(Date.now())
      const sessionID = () => {
        const route = api.route.current
        return route.name === "session" ? route.params.sessionID : undefined
      }
      const entries = createMemo(() => tracker.sync(sessionID(), sessionTools(api.state, sessionID(), options.showInputs)))
      const rows = createMemo(() => enabled() ? visibleTimers(entries(), now(), options) : [])
      const ticking = createMemo(() => rows().length > 0)
      createEffect(() => {
        if (!ticking()) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), options.refreshMs)
        timer.unref?.()
        onCleanup(() => clearInterval(timer))
      })

      const panel = createElement("box")
      setProp(panel, "flexShrink", 0)
      setProp(panel, "paddingLeft", 2)
      setProp(panel, "paddingRight", 2)
      createEffect(() => {
        setProp(panel, "visible", rows().length > 0)
        setProp(panel, "backgroundColor", api.theme.current.backgroundPanel)
      })
      const heading = createElement("text")
      createEffect(() => setProp(heading, "fg", api.theme.current.textMuted))
      insert(heading, "Tool timers")
      const body = createElement("box")
      insert(panel, [heading, body])
      insert(body, createComponent(For, {
        get each() { return rows().map((row) => row.id) },
        children(id) {
          const entry = createMemo(() => rows().find((row) => row.id === id))
          const line = createElement("box")
          setProp(line, "flexDirection", "row")
          setProp(line, "gap", 1)
          const name = createElement("text")
          setProp(name, "flexGrow", 1)
          setProp(name, "minWidth", 0)
          setProp(name, "wrapMode", "none")
          createEffect(() => setProp(name, "fg", api.theme.current.textMuted))
          insert(name, () => {
            const row = entry()
            return row ? `${row.tool}${row.summary ? ` · ${row.summary}` : ""}` : ""
          })
          const timer = createElement("text")
          setProp(timer, "flexShrink", 0)
          createEffect(() => setProp(timer, "fg", api.theme.current[
            entry()?.status === "error" ? "error" : entry()?.finished ? "textMuted" : "accent"
          ]))
          insert(timer, () => {
            const row = entry()
            if (!row) return ""
            return `${row.finished ? row.status === "error" ? "×" : "✓" : "⏱"} ${row.label}`
          })
          insert(line, [name, timer])
          onCleanup(() => line.destroy())
          return line
        },
      }))
      onCleanup(() => panel.destroy())
      return panel
    }

    // app_bottom is additive, works at narrow terminal widths, and remains
    // visible while the prompt is replaced by a permission/question dialog.
    api.slots.register({ order: 100, slots: { app_bottom: () => createComponent(Panel, {}) } })
  },
}
