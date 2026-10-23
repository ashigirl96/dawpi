#!/bin/sh
# PROTOTYPE (dawpi #4): starts relay.ts detached from the caller's stdio and
# returns once its socket answers, so `$.process.run` can launch it one-shot.
# usage: sh bootstrap.sh <socket> <log>
set -eu
sock=$1
log=$2
here=$(cd "$(dirname "$0")" && pwd)
rm -f "$sock"
nohup bun "$here/relay.ts" "$sock" </dev/null >"$log" 2>&1 &
i=0
until curl -sf --max-time 1 --unix-socket "$sock" http://relay/health >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 50 ] && { echo "bootstrap: relay did not come up" >&2; exit 1; }
  sleep 0.2
done
echo "bootstrap ready pid=$!"
