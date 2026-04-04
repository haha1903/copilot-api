import consola from "consola"
import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"
import { searchBrave } from "~/services/brave/search"

import type {
  AnthropicMessagesPayload,
  AnthropicServerTool,
  AnthropicServerToolUseBlock,
  AnthropicTool,
  AnthropicToolEntry,
  AnthropicWebSearchResult,
  AnthropicWebSearchToolResultBlock,
} from "./anthropic-types"

export const WEB_SEARCH_FUNCTION_NAME = "__web_search"

const WEB_SEARCH_TOOL_TYPES = new Set([
  "web_search_20250305",
  "web_search_20260209",
])

export interface WebSearchContext {
  enabled: boolean
  serverTool?: AnthropicServerTool
}

export function isServerTool(
  tool: AnthropicToolEntry,
): tool is AnthropicServerTool {
  return "type" in tool && WEB_SEARCH_TOOL_TYPES.has(tool.type as string)
}

/**
 * Extract web search server tools from the payload and replace with
 * a regular function tool that the model can call.
 */
export function preprocessWebSearch(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload
  context: WebSearchContext
} {
  if (!payload.tools || payload.tools.length === 0) {
    return { payload, context: { enabled: false } }
  }

  const serverTools: Array<AnthropicServerTool> = []
  const regularTools: Array<AnthropicTool> = []

  for (const tool of payload.tools) {
    if (isServerTool(tool)) {
      serverTools.push(tool)
    } else if ("name" in tool) {
      regularTools.push(tool)
    }
  }

  if (serverTools.length === 0) {
    return { payload, context: { enabled: false } }
  }

  const serverTool = serverTools[0]

  if (!state.braveApiKey) {
    consola.debug("Web search requested but no Brave API key, stripping")
    return {
      payload: {
        ...payload,
        tools: regularTools.length > 0 ? regularTools : undefined,
      },
      context: { enabled: false },
    }
  }

  const webSearchFunctionTool: AnthropicTool = {
    name: WEB_SEARCH_FUNCTION_NAME,
    description:
      "Search the web for current information. Use this when you need up-to-date information.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  }

  return {
    payload: {
      ...payload,
      tools: [...regularTools, webSearchFunctionTool],
    },
    context: {
      enabled: true,
      serverTool,
    },
  }
}

/**
 * Execute a web search via Brave and return Anthropic-formatted blocks.
 */
export async function executeWebSearch(
  query: string,
  serverTool?: AnthropicServerTool,
): Promise<{
  serverToolUse: AnthropicServerToolUseBlock
  toolResult: AnthropicWebSearchToolResultBlock
}> {
  const searchId = `srvtoolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`

  const apiKey = state.braveApiKey
  if (!apiKey) throw new Error("Brave API key not configured")

  let results: Array<{
    title: string
    url: string
    description: string
    page_age?: string
  }>
  try {
    results = await searchBrave(apiKey, {
      query,
      count: 5,
      allowed_domains: serverTool?.allowed_domains,
      blocked_domains: serverTool?.blocked_domains,
    })
  } catch (error) {
    consola.error("Web search failed:", error)
    results = [
      {
        title: "Search failed",
        url: "",
        description: `Web search for "${query}" failed. Please try again.`,
      },
    ]
  }

  const serverToolUse: AnthropicServerToolUseBlock = {
    type: "server_tool_use",
    id: searchId,
    name: "web_search",
    input: { query },
  }

  const toolResult: AnthropicWebSearchToolResultBlock = {
    type: "web_search_tool_result",
    tool_use_id: searchId,
    content: results.map(
      (r): AnthropicWebSearchResult => ({
        type: "web_search_result",
        url: r.url,
        title: r.title,
        encrypted_content: r.description,
        page_age: r.page_age,
      }),
    ),
  }

  return { serverToolUse, toolResult }
}

export function isWebSearchToolCall(toolName: string): boolean {
  return toolName === WEB_SEARCH_FUNCTION_NAME
}

/**
 * Format search results as readable text for the model continuation.
 */
export function formatSearchResultsAsText(
  results: AnthropicWebSearchToolResultBlock,
): string {
  return results.content
    .map((r) => `[${r.title}](${r.url})\n${r.encrypted_content}`)
    .join("\n\n")
}
