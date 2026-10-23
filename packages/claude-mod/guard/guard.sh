#!/bin/sh
home=${CODEX_BRIDGE_HOME:-$HOME/.codex-bridge}
input=$(cat)

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# Without a parse we cannot tell who is calling, so refuse every call that names a Roster agent anywhere.
roster_agent_in_raw_input() {
  for r in "$home"/sessions/*/roster/*; do
    [ -f "$r" ] || continue
    printf '%s' "$input" | grep -Eq "\"agent_id\" *: *\"${r##*/}\"" && return 0
  done
  return 1
}

if ! fields=$(printf '%s' "$input" | jq -er '[.agent_id // "", .tool_use_id // ""] | @tsv' 2>/dev/null); then
  roster_agent_in_raw_input && deny "codex-bridge: the Guard could not read this call"
  exit 0
fi
agent=${fields%%	*}
tool_use_id=${fields#*	}

case $agent in
  "" | *[!A-Za-z0-9_-]*) exit 0 ;;
esac
session_dir=
for r in "$home"/sessions/*/roster/"$agent"; do
  [ -f "$r" ] && session_dir=${r%/roster/*}
done
[ -n "$session_dir" ] || exit 0

case $tool_use_id in
  "" | *[!A-Za-z0-9_-]*) deny "codex-bridge: this Worker call has no Permit" ;;
esac
permit=$session_dir/permits/$tool_use_id
claimed=$permit.claimed.$$
# rename is atomic, so two calls racing for one Permit cannot both win it.
mv "$permit" "$claimed" 2>/dev/null || deny "codex-bridge: this Worker call has no Permit"
decision=$(jq -r --arg agent "$agent" 'if .agentId == $agent then .decision else "foreign" end' "$claimed" 2>/dev/null)
rm -f "$claimed"

case $decision in
  allow) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n' ;;
  none) ;;
  *) deny "codex-bridge: this Permit belongs to another call" ;;
esac
exit 0
