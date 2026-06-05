export interface SearchResult {
  url: string
  title: string
  snippet: string
  pageAge?: string
}

export interface SearchProvider {
  name: string
  search(query: string, maxResults: number): Promise<Array<SearchResult>>
}
