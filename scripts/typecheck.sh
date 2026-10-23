#!/bin/sh
set -e
tsc --noEmit -p .
# Claude Code lays the Mod's types only when a session loads the plugin with --plugin-dir.
if [ -f packages/claude-mod/.claude-plugin/types/tsconfig.json ]; then
  tsc --noEmit -p packages/claude-mod
else
  echo "skip packages/claude-mod: load it once with 'claude --plugin-dir packages/claude-mod' to lay .claude-plugin/types" >&2
fi
