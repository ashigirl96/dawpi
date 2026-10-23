#!/bin/sh
# PROTOTYPE (dawpi #16): the plugin's own PreToolUse settings hook (hooks.json `hooks`), loaded apart from the module.
# For an agent the Mod listed in /tmp/cbp16/workers, any tool call without a permit named by its tool_use_id is denied.
# It keys on agent_id, which stays the same when a worker whose type went away resumes as general-purpose.
# /tmp/cbp16/guard-permit holds what a permitted call gets: `allow` (no prompt) or `pass` (the normal flow).
input=$(cat)
agent=$(printf '%s' "$input" | jq -r '.agent_id // empty')
[ -n "$agent" ] && [ -f "/tmp/cbp16/workers/$agent" ] || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name')
id=$(printf '%s' "$input" | jq -r '.tool_use_id')
permit=/tmp/cbp16/permits/$id
decision=deny
if [ -f "$permit" ]; then
  rm -f "$permit"
  decision=$(cat /tmp/cbp16/guard-permit 2>/dev/null || echo pass)
fi
printf '%s' "$input" | jq -c --arg d "$decision" --arg t "$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000')" \
  '{t: $t, layer: "plugin", decision: $d, tool: .tool_name, tool_use_id, agent_id, agent_type, permission_mode, input: .tool_input}' >> /tmp/cbp16/guard.log
case "$decision" in
  deny)
    jq -n --arg tool "$tool" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: ("cbp16 guard: this worker may not call " + $tool + " on its own.")}}'
    ;;
  allow)
    jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"}}'
    ;;
esac
exit 0
