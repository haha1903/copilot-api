import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import {
  handleWebSearchEmulation,
  isOnlyWebSearchRequest,
  stripWebSearchTools,
} from "./web-search-emulation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (
    isOnlyWebSearchRequest(anthropicPayload)
    && state.searchManager?.enabled
  ) {
    return handleWebSearchEmulation(c, anthropicPayload)
  }

  const payload = stripWebSearchTools(anthropicPayload)
  const openAIPayload = translateToOpenAI(payload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(translateToAnthropic(response))
  }

  consola.debug("Streaming response from Copilot")
  return streamNormally(c, response)
}

function streamNormally(
  c: Context,
  response: AsyncIterable<{ data?: string }>,
) {
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const timer = createIdleTimer(stream)

    try {
      timer.reset()
      for await (const rawEvent of response) {
        timer.reset()
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    } catch (error) {
      consola.error("Stream processing error:", error)
      await emitStreamError(stream)
    } finally {
      timer.clear()
    }
  })
}

function createIdleTimer(stream: SSEStreamingApi) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    reset() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        consola.warn("Stream idle timeout reached, aborting")
        stream.abort()
      }, 30_000)
    },
    clear() {
      if (timer) clearTimeout(timer)
    },
  }
}

async function emitStreamError(stream: SSEStreamingApi) {
  try {
    const errorEvent = translateErrorToAnthropicErrorEvent()
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch {
    // Client may have already disconnected
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
