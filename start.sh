#!/bin/bash
# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  export $(grep -v '^#' "$(dirname "$0")/.env" | xargs)
fi
exec node "$(dirname "$0")/server.js"
