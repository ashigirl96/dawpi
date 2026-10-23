#!/bin/sh
# usage: sh launch.sh '<variant json>' <permission-mode> <tmux-session> [plugin dir]
# Starts a test Claude Code in tmux, with the parent session's env removed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=/tmp/cbp16-work
mkdir -p "$work" /tmp/cbp16
[ -f "$work/README.md" ] || printf '# cbp16 work\n\nA scratch directory for the cbp16 prototype.\n' > "$work/README.md"
printf '%s\n' "$1" > /tmp/cbp16-variant.json
tag=$(printf '%s' "$1" | jq -r '.tag')
stamp=$(date +%Y%m%dT%H%M%S)
cat > /tmp/cbp16-run.sh <<RUN
#!/bin/sh
for v in \$(env | sed -n 's/^\(CLAUDE[A-Z0-9_]*\)=.*/\1/p'); do unset "\$v"; done
cd "$work" || exit 1
exec ~/.local/bin/claude --plugin-dir "${4:-$here/mod}" --permission-mode "$2" --model haiku --debug-file "/tmp/cbp16-debug-$tag-$2-$stamp.log"
RUN
tmux new-session -d -s "$3" -x 200 -y 50 "sh /tmp/cbp16-run.sh"
echo "debug: /tmp/cbp16-debug-$tag-$2-$stamp.log"
