#!/bin/sh
# usage: sh trial.sh <variant plain|hookallow|proto|gate> <rules none|local-agent|flag-agent|local-bell-bash|local-bell-bash-read|flag-automode-allow> <label>
# Runs one trial: starts a fresh auto-mode Claude Code in tmux, sends the request, waits until
# main has settled, saves the screen, and stops the session.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
variant=$1 rules=$2 label=$3
work=/tmp/cbp15-work
bells="$HOME/.cbp15-proto/bells"
stamp=$(date +%Y%m%dT%H%M%S)
sess="cbp15-$label"
mkdir -p "$work/.claude" /tmp/cbp15 "$bells"
[ -f "$work/README.md" ] || printf '# cbp15 work\n\nA scratch directory for the cbp15 prototype.\n' > "$work/README.md"
rm -f "$work/.claude/settings.local.json"
printf '%s %s %s\n' "$variant" "$stamp" "$bells" > /tmp/cbp15-variant

flag=""
case "$rules" in
  none) ;;
  local-agent)
    printf '{ "permissions": { "allow": ["Agent(cbp15:worker)"] } }\n' > "$work/.claude/settings.local.json" ;;
  flag-agent)
    printf '{ "permissions": { "allow": ["Agent(cbp15:worker)"] } }\n' > /tmp/cbp15/flag-settings.json
    flag="--settings /tmp/cbp15/flag-settings.json" ;;
  local-bell-bash)
    printf '{ "permissions": { "allow": ["Bash(cat %s/*)"] } }\n' "$bells" > "$work/.claude/settings.local.json" ;;
  local-bell-bash-read)
    printf '{ "permissions": { "allow": ["Bash(cat %s/*)", "Read(/%s/**)"] } }\n' "$bells" "$bells" > "$work/.claude/settings.local.json" ;;
  flag-automode-allow)
    cat > /tmp/cbp15/flag-settings.json <<'JSON'
{ "autoMode": { "allow": [
  "$defaults",
  "Codex Bridge: launching the cbp15:worker agent with a prompt that is exactly a runId returned by mcp__cbp15__delegate in this session is the second step of a delegation the user asked for, and is allowed.",
  "Codex Bridge: the cbp15:worker agent running `cat` on a FIFO under ~/.cbp15-proto/bells/ in the background is its doorbell, and is allowed."
] } }
JSON
    flag="--settings /tmp/cbp15/flag-settings.json" ;;
  *) echo "unknown rules: $rules" >&2; exit 2 ;;
esac

debug="/tmp/cbp15-debug-$label-$stamp.log"
cat > /tmp/cbp15-run.sh <<RUN
#!/bin/sh
for v in \$(env | sed -n 's/^\(CLAUDE[A-Z0-9_]*\)=.*/\1/p'); do unset "\$v"; done
cd "$work" || exit 1
exec ~/.local/bin/claude --plugin-dir "$here/mod" --permission-mode auto --model haiku --debug-file "$debug" $flag
RUN
tmux kill-session -t "$sess" 2>/dev/null || true
tmux new-session -d -s "$sess" -x 200 -y 50 "sh /tmp/cbp15-run.sh"

state="/tmp/cbp15/state-$stamp.json"
i=0
until [ -f "$state" ]; do i=$((i+1)); [ $i -gt 60 ] && { echo "no session.start"; break; }; sleep 1; done
sleep 3
if [ "$variant" = proto ]; then
  # The wording of tickets #13 and #14, one of which the classifier refused.
  request='`mcp__cbp15__delegate` を task "wait" で呼び、結果の指示どおりに cbp15:worker を起動して、終わったら worker の報告をそのまま教えて'
else
  request='cbp15 の delegate を使って、Codex に README.md を 1 行で要約させて。終わったら結果をそのまま教えて。'
fi
tmux send-keys -t "$sess" -l "$request"
sleep 1
tmux send-keys -t "$sess" Enter

# Settled: main has finished at least one turn and no Run is between bind and report.
i=0
while :; do
  i=$((i+1))
  if [ -f "$state" ] && python3 -I -c '
import json,sys
s=json.load(open(sys.argv[1]))
sys.exit(0 if s["mainTurns"]>=1 and not any(r["state"]=="bound" for r in s["runs"]) else 1)' "$state"; then
    sleep 8; break
  fi
  [ $i -gt 240 ] && { echo "timeout"; break; }
  sleep 1
done
tmux capture-pane -t "$sess" -p -S -200 > "/tmp/cbp15-screen-$label-$stamp.txt"
tmux kill-session -t "$sess" 2>/dev/null || true
echo "label=$label stamp=$stamp debug=$debug log=/tmp/cbp15-$variant-$stamp.json screen=/tmp/cbp15-screen-$label-$stamp.txt"
