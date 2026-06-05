import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { authMiddleware } from "./lib/auth"
import { state } from "./lib/state"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(authMiddleware)
server.use(
  cors({
    origin: (origin) => {
      const allowed = process.env.CORS_ORIGINS?.split(",") ?? []
      if (allowed.length > 0) return allowed.includes(origin) ? origin : null
      // Default: allow localhost on any port
      if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
        return origin
      return null
    },
  }),
)

server.get("/", (c) => c.text("Server running"))

server.get("/health", (c) =>
  c.json({
    status: "ok",
    hasToken: Boolean(state.copilotToken),
  }),
)

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/responses", responsesRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
