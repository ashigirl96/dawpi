#!/bin/sh
# usage: sh launch.sh <variant A|B|C> <permission-mode> <tmux-session>
# Starts a test Claude Code in tmux, with the parent session's env removed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=/tmp/cbp11-work
mkdir -p "$work"
[ -f "$work/README.md" ] || printf '# cbp11 work\n\nA scratch directory for the cbp11 prototype.\n' > "$work/README.md"
printf '%s\n' "$1" > /tmp/cbp11-variant
stamp=$(date +%Y%m%dT%H%M%S)
cat > /tmp/cbp11-run.sh <<RUN
#!/bin/sh
for v in \$(env | sed -n 's/^\(CLAUDE[A-Z0-9_]*\)=.*/\1/p'); do unset "\$v"; done
cd "$work" || exit 1
exec ~/.local/bin/claude --plugin-dir "$here/mod" --permission-mode "$2" --model haiku --debug-file "/tmp/cbp11-debug-$1-$2-$stamp.log"
RUN
tmux new-session -d -s "$3" -x 200 -y 50 "sh /tmp/cbp11-run.sh"
echo "debug: /tmp/cbp11-debug-$1-$2-$stamp.log"
