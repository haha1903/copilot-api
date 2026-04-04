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
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicMessagesPayload,
  type AnthropicServerToolUseBlock,
  type AnthropicStreamState,
  type AnthropicWebSearchResult,
  type AnthropicWebSearchToolResultBlock,
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
  executeWebSearch,
  isWebSearchToolCall,
  preprocessWebSearch,
  type WebSearchContext,
} from "./web-search"

interface RequestContext {
  c: Context
  payload: AnthropicMessagesPayload
  webSearch: WebSearchContext
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const { payload, context: webSearch } = preprocessWebSearch(anthropicPayload)
  const openAIPayload = translateToOpenAI(payload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)
  const ctx: RequestContext = { c, payload, webSearch }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response:",
      JSON.stringify(response).slice(-400),
    )
    return handleNonStreamingResponse(ctx, response)
  }

  consola.debug("Streaming response from Copilot")
  return handleStreamingResponse(ctx, response)
}

// Non-streaming

async function handleNonStreamingResponse(
  ctx: RequestContext,
  response: ChatCompletionResponse,
) {
  // Check all choices for web search tool calls
  const allToolCalls = response.choices.flatMap(
    (choice) => choice.message.tool_calls ?? [],
  )
  const webSearchCall = allToolCalls.find((tc) =>
    isWebSearchToolCall(tc.function.name),
  )

  if (!ctx.webSearch.enabled || !webSearchCall) {
    return ctx.c.json(translateToAnthropic(response))
  }

  consola.info("Web search triggered (non-streaming)")

  const searchArgs = JSON.parse(webSearchCall.function.arguments) as {
    query: string
  }
  const { serverToolUse, toolResult } = await executeWebSearch(
    searchArgs.query,
    ctx.webSearch.serverTool,
  )

  const continuationOpenAI = translateToOpenAI(
    buildContinuationPayload(ctx.payload, webSearchCall, toolResult),
  )
  continuationOpenAI.stream = false

  const finalResponse = await createChatCompletions(continuationOpenAI)
  if (!isNonStreaming(finalResponse)) {
    throw new Error("Expected non-streaming response for continuation")
  }

  const finalAnthropic = translateToAnthropic(finalResponse)
  finalAnthropic.content = [
    serverToolUse as unknown as AnthropicAssistantContentBlock,
    toolResult as unknown as AnthropicAssistantContentBlock,
    ...finalAnthropic.content,
  ]

  return ctx.c.json(finalAnthropic)
}

function buildContinuationPayload(
  original: AnthropicMessagesPayload,
  webSearchCall: ToolCall,
  toolResult: { content: Array<AnthropicWebSearchResult> },
): AnthropicMessagesPayload {
  const resultsText = toolResult.content
    .map((r) => `[${r.title}](${r.url})\n${r.encrypted_content}`)
    .join("\n\n")

  return {
    ...original,
    tools: undefined,
    tool_choice: undefined,
    messages: [
      ...original.messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: webSearchCall.id,
            name: webSearchCall.function.name,
            input: JSON.parse(webSearchCall.function.arguments) as Record<
              string,
              unknown
            >,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: webSearchCall.id,
            content: resultsText,
          },
        ],
      },
    ],
  }
}

// Streaming helpers

interface BufferedToolCall {
  id: string
  name: string
  arguments: string
}

interface BufferedStreamResponse {
  id: string
  model: string
  textContent: string
  toolCalls: Array<BufferedToolCall>
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  finishReason: string | null
}

function buildUsage(buffered: BufferedStreamResponse, extraOutput = 0) {
  return {
    input_tokens: buffered.inputTokens,
    output_tokens: buffered.outputTokens + extraOutput,
    ...(buffered.cacheReadTokens !== undefined && {
      cache_read_input_tokens: buffered.cacheReadTokens,
    }),
  }
}

function parseChunkUsage(chunk: ChatCompletionChunk) {
  if (!chunk.usage) return undefined
  const cached = chunk.usage.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: chunk.usage.prompt_tokens - (cached ?? 0),
    outputTokens: chunk.usage.completion_tokens,
    cacheReadTokens: cached,
  }
}

async function bufferStreamResponse(
  stream: AsyncIterable<{ data?: string }>,
): Promise<BufferedStreamResponse> {
  const result: BufferedStreamResponse = {
    id: "",
    model: "",
    textContent: "",
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    finishReason: null,
  }
  const toolCallMap: Record<number, BufferedToolCall> = {}

  for await (const rawEvent of stream) {
    if (rawEvent.data === "[DONE]" || !rawEvent.data) {
      if (rawEvent.data === "[DONE]") break
      continue
    }

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    if (!result.id) result.id = chunk.id
    if (!result.model) result.model = chunk.model

    const usage = parseChunkUsage(chunk)
    if (usage) {
      result.inputTokens = usage.inputTokens
      result.outputTokens = usage.outputTokens
      result.cacheReadTokens = usage.cacheReadTokens
    }

    const choice = chunk.choices[0]
    if (!choice) continue // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    if (choice.delta.content) result.textContent += choice.delta.content
    if (choice.delta.tool_calls)
      bufferToolCalls(choice.delta.tool_calls, toolCallMap)
    if (choice.finish_reason) result.finishReason = choice.finish_reason
  }

  result.toolCalls = Object.values(toolCallMap)
  return result
}

function bufferToolCalls(
  calls: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>,
  map: Record<number, BufferedToolCall>,
) {
  for (const tc of calls) {
    if (tc.id && tc.function?.name) {
      map[tc.index] = {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments ?? "",
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (tc.function?.arguments && map[tc.index]) {
      map[tc.index].arguments += tc.function.arguments
    }
  }
}

// Streaming: main entry

async function handleStreamingResponse(
  ctx: RequestContext,
  responseStream: AsyncIterable<{ data?: string }>,
) {
  if (!ctx.webSearch.enabled) {
    return streamNormally(ctx.c, responseStream)
  }

  const buffered = await bufferStreamResponse(responseStream)
  const webSearchCall = buffered.toolCalls.find((tc) =>
    isWebSearchToolCall(tc.name),
  )

  if (!webSearchCall) {
    return replayBufferedAsStream(ctx.c, buffered)
  }

  consola.info("Web search triggered (streaming)")
  return streamWithWebSearch(ctx, buffered, webSearchCall)
}

async function streamWithWebSearch(
  ctx: RequestContext,
  buffered: BufferedStreamResponse,
  webSearchCall: BufferedToolCall,
) {
  const searchArgs = JSON.parse(webSearchCall.arguments) as { query: string }
  const { serverToolUse, toolResult } = await executeWebSearch(
    searchArgs.query,
    ctx.webSearch.serverTool,
  )

  const fakeToolCall: ToolCall = {
    id: webSearchCall.id,
    type: "function",
    function: { name: webSearchCall.name, arguments: webSearchCall.arguments },
  }
  const continuationOpenAI = translateToOpenAI(
    buildContinuationPayload(ctx.payload, fakeToolCall, toolResult),
  )
  continuationOpenAI.stream = true
  const continuationStream = await createChatCompletions(continuationOpenAI)

  return streamSSE(ctx.c, async (stream) => {
    const timer = createIdleTimer(stream)
    try {
      timer.reset()
      await emitMessageStart(stream, buffered)
      let blockIndex = 0
      blockIndex = await emitServerToolUseBlock(
        stream,
        blockIndex,
        serverToolUse,
      )
      blockIndex = await emitSearchResultBlock(stream, blockIndex, toolResult)

      if (!isNonStreaming(continuationStream)) {
        await streamContinuation({
          stream,
          source: continuationStream as AsyncIterable<{ data?: string }>,
          startIndex: blockIndex,
          buffered,
          timer,
        })
      }
    } catch (error) {
      consola.error("Stream processing error:", error)
      await emitStreamError(stream)
    } finally {
      timer.clear()
    }
  })
}

// SSE emit helpers

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

async function emitMessageStart(
  stream: SSEStreamingApi,
  buffered: BufferedStreamResponse,
) {
  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: buffered.id,
        type: "message",
        role: "assistant",
        content: [],
        model: buffered.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...buildUsage(buffered), output_tokens: 0 },
      },
    }),
  })
}

async function emitServerToolUseBlock(
  stream: SSEStreamingApi,
  index: number,
  block: AnthropicServerToolUseBlock,
) {
  await emitBlockWithDelta({
    stream,
    index,
    contentBlock: {
      type: "server_tool_use",
      id: block.id,
      name: block.name,
      input: {},
    },
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(block.input),
    },
  })
  return index + 1
}

async function emitSearchResultBlock(
  stream: SSEStreamingApi,
  index: number,
  block: AnthropicWebSearchToolResultBlock,
) {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
      },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  })
  return index + 1
}

interface BlockWithDelta {
  stream: SSEStreamingApi
  index: number
  contentBlock: Record<string, unknown>
  delta: Record<string, unknown>
}

async function emitBlockWithDelta(opts: BlockWithDelta) {
  await opts.stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index: opts.index,
      content_block: opts.contentBlock,
    }),
  })
  await opts.stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: opts.index,
      delta: opts.delta,
    }),
  })
  await opts.stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index: opts.index }),
  })
}

interface ContinuationOpts {
  stream: SSEStreamingApi
  source: AsyncIterable<{ data?: string }>
  startIndex: number
  buffered: BufferedStreamResponse
  timer: { reset: () => void }
}

async function streamContinuation(opts: ContinuationOpts) {
  let textBlockOpen = false

  for await (const rawEvent of opts.source) {
    opts.timer.reset()
    if (rawEvent.data === "[DONE]" || !rawEvent.data) {
      if (rawEvent.data === "[DONE]") break
      continue
    }

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    const choice = chunk.choices[0]
    if (!choice) continue // eslint-disable-line @typescript-eslint/no-unnecessary-condition

    if (choice.delta.content) {
      if (!textBlockOpen) {
        await opts.stream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: opts.startIndex,
            content_block: { type: "text", text: "" },
          }),
        })
        textBlockOpen = true
      }
      await opts.stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: opts.startIndex,
          delta: { type: "text_delta", text: choice.delta.content },
        }),
      })
    }

    if (choice.finish_reason) {
      if (textBlockOpen) {
        await opts.stream.writeSSE({
          event: "content_block_stop",
          data: JSON.stringify({
            type: "content_block_stop",
            index: opts.startIndex,
          }),
        })
      }
      const extraOutput = chunk.usage?.completion_tokens ?? 0
      await emitMessageEnd(opts.stream, opts.buffered, extraOutput)
    }
  }
}

async function emitMessageEnd(
  stream: SSEStreamingApi,
  buffered: BufferedStreamResponse,
  extraOutput: number,
) {
  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: buildUsage(buffered, extraOutput),
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
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

// Normal streaming (no web search)

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

// Replay buffered response as stream

function replayBufferedAsStream(c: Context, buffered: BufferedStreamResponse) {
  return streamSSE(c, async (stream) => {
    await emitMessageStart(stream, buffered)
    let blockIndex = 0

    if (buffered.textContent) {
      await emitBlockWithDelta({
        stream,
        index: blockIndex,
        contentBlock: { type: "text", text: "" },
        delta: { type: "text_delta", text: buffered.textContent },
      })
      blockIndex++
    }

    for (const tc of buffered.toolCalls) {
      await emitBlockWithDelta({
        stream,
        index: blockIndex,
        contentBlock: {
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: {},
        },
        delta: { type: "input_json_delta", partial_json: tc.arguments },
      })
      blockIndex++
    }

    const stopReason = mapBufferedStopReason(buffered)
    await stream.writeSSE({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: buildUsage(buffered),
      }),
    })
    await stream.writeSSE({
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop" }),
    })
  })
}

function mapBufferedStopReason(buffered: BufferedStreamResponse): string {
  if (buffered.toolCalls.length > 0) return "tool_use"
  if (buffered.finishReason === "stop") return "end_turn"
  if (buffered.finishReason === "length") return "max_tokens"
  return "end_turn"
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
