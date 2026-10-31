import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createHooks } from "./timestamps.js"

export default async function MessageTimestamps({ client }) {
  // OpenCode 1.19 supplies the legacy SDK to server plugins. Reuse its existing
  // transport (including authentication and in-process fetch) with the v2 SDK,
  // which exposes the message-part update endpoint.
  const sdk = new OpencodeClient({ client: client._client })
  return createHooks(sdk, (error) => client.app.log({
    body: {
      service: "message-timestamps",
      level: "warn",
      message: "Could not add an answer timestamp",
      extra: { error: String(error) },
    },
  }))
}
