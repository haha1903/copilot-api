import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import {
  Agent,
  ProxyAgent,
  RetryAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici"

const AGENT_OPTIONS = {
  connectTimeout: 10_000,
  bodyTimeout: 30_000,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
} as const

const RETRY_OPTIONS = {
  maxRetries: 3,
  minTimeout: 1_000,
  maxTimeout: 4_000,
  timeoutFactor: 2,
  methods: [
    "GET",
    "HEAD",
    "OPTIONS",
    "PUT",
    "DELETE",
    "TRACE",
    "POST",
  ] as Array<Dispatcher.HttpMethod>,
  statusCodes: [500, 502, 503, 504, 429] as Array<number>,
  errorCodes: [
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ] as Array<string>,
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    const direct = new Agent(AGENT_OPTIONS)
    const proxies = new Map<string, ProxyAgent>()

    // Minimal dispatcher that routes requests through proxy when configured.
    // Typed as plain object and cast to Dispatcher to avoid implementing
    // every abstract method.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent(proxyUrl)
            proxies.set(proxyUrl, agent)
          }
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          } catch {
            /* noop */
          }
          consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        } catch (err) {
          consola.warn("Proxy dispatch error, falling back to direct:", err)
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        return direct.close()
      },
      destroy() {
        return direct.destroy()
      },
    }

    const retryAgent = new RetryAgent(
      dispatcher as unknown as Dispatcher,
      RETRY_OPTIONS,
    )

    setGlobalDispatcher(retryAgent)
    consola.debug("HTTP proxy + retry configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}
