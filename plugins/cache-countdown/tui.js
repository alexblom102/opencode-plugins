import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { countdown, describe, latestActivity, parseOptions } from "./cache.js"

// These UI modules are supplied by OpenCode's TUI plugin runtime. No npm install
// or JSX build step is required for this local plugin.
const plugin = {
  id: "local:cache-countdown",
  async tui(api, rawOptions) {
    const options = parseOptions(rawOptions)
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    timer.unref?.()
    api.lifecycle.onDispose(() => clearInterval(timer))

    function activity(sessionID) {
      return latestActivity(api.state.session.messages(sessionID), (id) => api.state.part(id))
    }

    function state(last) {
      const model = last && api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
      return countdown(last, now(), options, model?.api?.id)
    }

    function showDetails(sessionID) {
      const last = sessionID ? activity(sessionID) : undefined
      api.ui.toast({
        title: "Prompt cache countdown",
        message: describe(last, state(last)),
        variant: "info",
        duration: 12000,
      })
    }

    api.keymap.registerLayer({
      commands: [
        {
          name: "cache-countdown.status",
          title: "Cache countdown: show details",
          desc: "Show the last request's cache usage and estimated lifetime",
          category: "Session",
          namespace: "palette",
          slashName: "cache",
          run() {
            api.ui.dialog.clear()
            const route = api.route.current
            showDetails(route.name === "session" ? route.params.sessionID : undefined)
          },
        },
      ],
    })

    api.slots.register({
      order: 200,
      slots: {
        session_prompt_right(_context, props) {
          const last = createMemo(() => activity(props.session_id))
          const display = createMemo(() => state(last()))
          const text = createElement("text")
          setProp(text, "onMouseDown", () => showDetails(props.session_id))
          createEffect(() => setProp(text, "fg", api.theme.current[display().color]))
          insert(text, () => display().label)
          onCleanup(() => text.destroy())
          return text
        },
      },
    })
  },
}

export default plugin
