#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun run dist/main.mjs auth
else
  # Default command
  exec bun run dist/main.mjs start -g "$GH_TOKEN" "$@"
fi

