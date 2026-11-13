#!/bin/sh
# Wait a bit, then report whether the Obsidian page still answers.
sleep "${1:-3}"
timeout 5 node "$(dirname "$0")/cdp.mjs" 47300 'return "alive"' >/dev/null 2>&1 && echo ALIVE || echo HUNG
