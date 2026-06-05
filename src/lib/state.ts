import type { ModelsResponse } from "~/services/copilot/get-models"
import type { SearchManager } from "~/services/search/manager"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  searchManager?: SearchManager
  apiKey?: string

  tokenRefreshTimer?: ReturnType<typeof setInterval>
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
