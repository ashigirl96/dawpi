#!/bin/sh
# usage: sh run-unload.sh '<variant json>' <permission-mode> <unload: empty|none> [rm-guard]
# Launches from a /tmp copy of the Mod, waits until the worker sleeps on its doorbell,
# swaps the Mod for an empty module (unless none), rings the doorbell from the shell, and prints the logs.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmux kill-session -t cbp16 2>/dev/null || true
pkill -f "cat /tmp/cbp16/bells" 2>/dev/null || true
rm -rf /tmp/cbp16 /tmp/cbp16-mod
mkdir -p /tmp/cbp16
cp -R "$here/mod" /tmp/cbp16-mod
rm -rf /tmp/cbp16-mod/.claude-plugin/types
echo allow > /tmp/cbp16/guard-permit
sh "$here/launch.sh" "$1" "$2" cbp16 /tmp/cbp16-mod
tag=$(printf '%s' "$1" | jq -r '.tag')
sleep 8
tmux send-keys -t cbp16 -l 'Call the Agent tool once with subagent_type "cbp16:worker", description "cbp16 w1", prompt "start". When it finishes, tell me its final reply verbatim. Do nothing else.'
sleep 1
tmux send-keys -t cbp16 C-m
i=0
until ls /tmp/cbp16/bells/* >/dev/null 2>&1 && grep -q '"wake.external"' /tmp/cbp16-"$tag"-*.json 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "worker never slept"; exit 1; }; sleep 1
done
bell=$(ls /tmp/cbp16/bells/* | head -1)
echo "asleep on $bell"
if [ "$3" = empty ]; then
  printf '%s\n' "import type { Register } from 'claude-code'" "export const register: Register = () => {}" > /tmp/cbp16-mod/hooks/empty.ts
  jq '.modules = ["./empty.ts"]' "$here/mod/hooks/hooks.json" > /tmp/cbp16-mod/hooks/hooks.json
  sleep 3
  # A turn of the main loop makes the watch's reload land.
  tmux send-keys -t cbp16 -l 'Reply with the single word OK.'
  tmux send-keys -t cbp16 C-m
  sleep 10
  grep -h 'reloaded (modules' /tmp/cbp16-debug-"$tag"-*.log | cut -c1-200
fi
[ "${4:-}" = rm-guard ] && rm -f /tmp/cbp16-mod/plugin-guard.sh && echo "removed plugin-guard.sh"
sh -c "exec 3<>$bell; echo ring >&3"
echo "rang $bell"
sleep 40
echo '--- guard'
jq -c '{t,decision,tool,tool_use_id,input}' /tmp/cbp16/guard.log | cut -c1-260
echo '--- markers'
ls /tmp/cbp16/markers
echo '--- pane'
tmux capture-pane -p -t cbp16 | grep -v '^\s*$' | tail -25
