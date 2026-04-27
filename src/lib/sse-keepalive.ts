import type { SSEStreamingApi } from "hono/streaming"

const DEFAULT_INTERVAL_MS = 25_000

// startSSEKeepAlive periodically writes an SSE comment line so that
// intermediate proxies (e.g. Cloudflare's 100s idle limit) do not close
// the connection while the upstream model is reasoning silently. SSE
// comment lines (starting with ":") are ignored by spec-compliant clients.
export function startSSEKeepAlive(
  stream: SSEStreamingApi,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    stream.write(": keepalive\n\n").catch(() => {})
  }, intervalMs)
  return () => clearInterval(timer)
}
