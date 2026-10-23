#!/bin/sh
# PreToolUse (Write|Edit): refuses destructive commands written into prototypes/.
# A prototype's text can reach a model running in auto mode, which runs commands without asking.
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
case "$path" in
  */prototypes/*) ;;
  *) exit 0 ;;
esac
text=$(printf '%s' "$input" | jq -r '[.tool_input.content, .tool_input.new_string] | map(select(. != null)) | join("\n")')
hit=$(printf '%s\n' "$text" | grep -n -E 'rm[[:space:]]+-[a-zA-Z]*[rR]|\.ssh(/|\b)|\|[[:space:]]*(ba|z)?sh\b|mkfs|dd[[:space:]]+if=' | head -3)
[ -z "$hit" ] && exit 0
jq -n --arg hit "$hit" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("prototypes/ に破壊的なコマンドの形があります:\n" + $hit + "\n試験の payload は無害な印の file を作る指示（touch /tmp/<name>-marker）にしてください。")
  }
}'
