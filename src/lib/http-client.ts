const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Fetch wrapper that adds an AbortController-based timeout.
 * Falls through to the global fetch (and therefore the global dispatcher
 * which already carries retry + proxy logic).
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const existing = init?.signal

  if (existing) {
    if (existing.aborted) {
      controller.abort(existing.reason)
    } else {
      existing.addEventListener("abort", () => {
        controller.abort(existing.reason)
      })
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
