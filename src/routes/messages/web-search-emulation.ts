import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type { SearchResult } from "~/services/search/types"

import { state } from "~/lib/state"

import type {
  AnthropicMessagesPayload,
  AnthropicToolEntry,
} from "./anthropic-types"

const WEB_SEARCH_IDENTIFIERS = new Set([
  "web_search",
  "web_search_20250305",
  "web_search_20260209",
  "google_search",
])

const TOKEN_ESTIMATE_DIVISOR = 4

function isWebSearchTool(tool: AnthropicToolEntry): boolean {
  if ("type" in tool && WEB_SEARCH_IDENTIFIERS.has(tool.type as string))
    return true
  if ("name" in tool && WEB_SEARCH_IDENTIFIERS.has(tool.name)) return true
  return false
}

export function isOnlyWebSearchRequest(
  payload: AnthropicMessagesPayload,
): boolean {
  if (!payload.tools || payload.tools.length !== 1) return false
  return isWebSearchTool(payload.tools[0])
}

export function stripWebSearchTools(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  if (!payload.tools) return payload
  const filtered = payload.tools.filter((t) => !isWebSearchTool(t))
  return {
    ...payload,
    tools: filtered.length > 0 ? filtered : undefined,
  }
}

function extractQuery(payload: AnthropicMessagesPayload): string | undefined {
  const last = payload.messages.at(-1)
  if (!last || last.role !== "user") return undefined

  if (typeof last.content === "string") {
    return last.content || undefined
  }

  if (Array.isArray(last.content)) {
    for (const block of last.content) {
      if (block.type === "text" && "text" in block && block.text) {
        return block.text
      }
    }
  }
  return undefined
}

function buildTextSummary(query: string, results: Array<SearchResult>): string {
  if (results.length === 0) {
    return `No search results found for: ${query}`
  }
  let sb = `Here are the search results for "${query}":\n\n`
  for (const [i, r] of results.entries()) {
    sb += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`
  }
  return sb
}

function buildResultBlocks(results: Array<SearchResult>) {
  return results.map((r) => {
    const block: Record<string, unknown> = {
      type: "web_search_result",
      url: r.url,
      title: r.title,
    }
    if (r.snippet) block.page_content = r.snippet
    if (r.pageAge) block.page_age = r.pageAge
    return block
  })
}

interface SynthesizedSearch {
  messageId: string
  model: string
  outputTokens: number
  serverToolUseBlock: Record<string, unknown>
  toolResultBlock: Record<string, unknown>
  summary: string
}

function streamSearchResponse(c: Context, s: SynthesizedSearch) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: s.messageId,
          type: "message",
          role: "assistant",
          model: s.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    })

    await stream.writeSSE({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: s.serverToolUseBlock,
      }),
    })
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: 0 }),
    })

    await stream.writeSSE({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: s.toolResultBlock,
      }),
    })
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: 1 }),
    })

    await stream.writeSSE({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      }),
    })
    await stream.writeSSE({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: s.summary },
      }),
    })
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: 2 }),
    })

    await stream.writeSSE({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: s.outputTokens },
      }),
    })
    await stream.writeSSE({
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop" }),
    })
  })
}

export async function handleWebSearchEmulation(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  const searchManager = state.searchManager
  if (!searchManager?.enabled) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Web search not configured",
        },
      },
      400,
    )
  }

  const query = extractQuery(payload)
  if (!query) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: "No search query found in messages",
        },
      },
      400,
    )
  }

  consola.info(`Web search emulation: "${query}"`)

  const results = await searchManager.search(query)
  const summary = buildTextSummary(query, results)

  const messageId = `msg_ws_${randomUUID().replaceAll("-", "").slice(0, 24)}`
  const toolUseId = `srvtoolu_ws_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  const model = payload.model || "claude-sonnet-4-6"
  const outputTokens = Math.ceil(summary.length / TOKEN_ESTIMATE_DIVISOR)

  const serverToolUseBlock = {
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: { query },
  }
  const toolResultBlock = {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: buildResultBlocks(results),
  }

  if (!payload.stream) {
    return c.json({
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [
        serverToolUseBlock,
        toolResultBlock,
        { type: "text", text: summary },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: outputTokens },
    })
  }

  return streamSearchResponse(c, {
    messageId,
    model,
    outputTokens,
    serverToolUseBlock,
    toolResultBlock,
    summary,
  })
}
