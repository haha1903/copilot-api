import type { Context, Next } from "hono"

import { state } from "./state"

export async function authMiddleware(c: Context, next: Next) {
  if (!state.apiKey) {
    return next()
  }

  const key =
    c.req.header("x-api-key")
    || c.req.header("api-key")
    || c.req.header("authorization")?.replace(/^Bearer\s+/i, "")

  if (!key) {
    return c.json(
      { error: { type: "authentication_error", message: "Missing API key" } },
      401,
    )
  }

  if (key !== state.apiKey) {
    return c.json(
      { error: { type: "authentication_error", message: "Invalid API key" } },
      401,
    )
  }

  return next()
}
