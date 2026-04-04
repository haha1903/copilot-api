import consola from "consola"

import { fetchWithTimeout } from "~/lib/http-client"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"

export interface BraveSearchParams {
  query: string
  count?: number
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
}

export interface BraveSearchResult {
  title: string
  url: string
  description: string
  page_age?: string
}

interface BraveWebResult {
  title: string
  url: string
  description: string
  page_age?: string
}

interface BraveSearchResponse {
  web?: {
    results: Array<BraveWebResult>
  }
}

export async function searchBrave(
  apiKey: string,
  params: BraveSearchParams,
): Promise<Array<BraveSearchResult>> {
  const url = new URL(BRAVE_SEARCH_URL)
  url.searchParams.set("q", params.query)
  url.searchParams.set("count", String(params.count ?? 5))

  consola.debug("Brave Search query:", params.query)

  const response = await fetchWithTimeout(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    consola.error("Brave Search API error:", response.status, text)
    throw new Error(`Brave Search failed: ${response.status}`)
  }

  const data = (await response.json()) as BraveSearchResponse
  let results = data.web?.results ?? []

  if (params.allowed_domains && params.allowed_domains.length > 0) {
    const allowed = params.allowed_domains
    results = results.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname
        return allowed.some((d) => hostname.includes(d))
      } catch {
        return false
      }
    })
  }

  if (params.blocked_domains && params.blocked_domains.length > 0) {
    const blocked = params.blocked_domains
    results = results.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname
        return !blocked.some((d) => hostname.includes(d))
      } catch {
        return true
      }
    })
  }

  consola.debug(`Brave Search returned ${results.length} results`)

  return results.map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    page_age: r.page_age,
  }))
}
