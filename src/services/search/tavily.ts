import consola from "consola"

import { fetchWithTimeout } from "~/lib/http-client"

import type { SearchProvider, SearchResult } from "./types"

const TAVILY_SEARCH_URL = "https://api.tavily.com/search"

interface TavilyResult {
  url: string
  title: string
  content: string
}

interface TavilySearchResponse {
  results: Array<TavilyResult>
}

export class TavilySearchProvider implements SearchProvider {
  name = "tavily"
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async search(
    query: string,
    maxResults: number,
  ): Promise<Array<SearchResult>> {
    consola.debug(`Tavily search: "${query}"`)

    const response = await fetchWithTimeout(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `Tavily Search failed (${response.status}): ${text.slice(0, 200)}`,
      )
    }

    const data = (await response.json()) as TavilySearchResponse
    return data.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
    }))
  }
}
