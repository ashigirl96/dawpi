#!/bin/sh
# PROTOTYPE (dawpi #16): the worker's own PreToolUse settings hook, from its AgentSpec.
# Lets an Agent or Bash call through only when the Mod left a permit named by its tool_use_id;
# the model cannot choose a tool_use_id, and with the Mod gone no permit appears.
# /tmp/cbp16/guard-permit holds what a permitted call gets: `allow` (no prompt) or `pass` (the normal flow).
input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name')
id=$(printf '%s' "$input" | jq -r '.tool_use_id')
permit=/tmp/cbp16/permits/$id
decision=deny
case "$tool" in
  Agent|Bash)
    if [ -f "$permit" ]; then
      rm -f "$permit"
      decision=$(cat /tmp/cbp16/guard-permit 2>/dev/null || echo pass)
    fi
    ;;
  *) decision=pass ;;
esac
printf '%s' "$input" | jq -c --arg d "$decision" --arg t "$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000')" \
  '{t: $t, decision: $d, tool: .tool_name, tool_use_id, agent_id, agent_type, permission_mode, input: .tool_input}' >> /tmp/cbp16/guard.log
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
