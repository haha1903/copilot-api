import consola from "consola"

import { fetchWithTimeout } from "~/lib/http-client"

import type { SearchProvider, SearchResult } from "./types"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
const BRAVE_MAX_COUNT = 20

interface BraveWebResult {
  title: string
  url: string
  description: string
  age?: string
}

interface BraveSearchResponse {
  web?: {
    results: Array<BraveWebResult>
  }
}

export class BraveSearchProvider implements SearchProvider {
  name = "brave"
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async search(
    query: string,
    maxResults: number,
  ): Promise<Array<SearchResult>> {
    const count = Math.min(maxResults, BRAVE_MAX_COUNT)
    const url = new URL(BRAVE_SEARCH_URL)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(count))

    consola.debug(`Brave search: "${query}"`)

    const response = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `Brave Search failed (${response.status}): ${text.slice(0, 200)}`,
      )
    }

    const data = (await response.json()) as BraveSearchResponse
    const results = data.web?.results ?? []

    return results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.description,
      pageAge: r.age || undefined,
    }))
  }
}
