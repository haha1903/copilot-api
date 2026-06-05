import consola from "consola"

import type { SearchProvider, SearchResult } from "./types"

export const DEFAULT_MAX_RESULTS = 5

export class SearchManager {
  private cursor = 0
  private providers: Array<SearchProvider>

  constructor(providers: Array<SearchProvider>) {
    this.providers = providers
  }

  get enabled(): boolean {
    return this.providers.length > 0
  }

  providerNames(): string {
    return this.providers.map((p) => p.name).join(", ")
  }

  async search(
    query: string,
    maxResults = DEFAULT_MAX_RESULTS,
  ): Promise<Array<SearchResult>> {
    const n = this.providers.length
    if (n === 0) return []

    const start = this.cursor++ % n

    for (let offset = 0; offset < n; offset++) {
      const provider = this.providers[(start + offset) % n]
      try {
        const results = await provider.search(query, maxResults)
        consola.debug(
          `Search via '${provider.name}': ${results.length} results`,
        )
        return results
      } catch (error) {
        consola.warn(`Search provider '${provider.name}' failed:`, error)
      }
    }

    consola.error(`All search providers failed for query: "${query}"`)
    return []
  }
}
