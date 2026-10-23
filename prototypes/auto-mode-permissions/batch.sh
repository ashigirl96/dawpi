#!/bin/sh
# usage: sh batch.sh <out file> <label>:<variant>:<rules> ...
# Runs trials one after another and appends each summary to the out file.
here=$(cd "$(dirname "$0")" && pwd)
out=$1
shift
for spec in "$@"; do
  label=${spec%%:*}
  rest=${spec#*:}
  variant=${rest%%:*}
  rules=${rest#*:}
  line=$(sh "$here/trial.sh" "$variant" "$rules" "$label" | tail -1)
  echo "$line" >> "$out.index"
  debug=$(printf '%s\n' "$line" | sed -n 's/.* debug=\([^ ]*\).*/\1/p')
  log=$(printf '%s\n' "$line" | sed -n 's/.* log=\([^ ]*\).*/\1/p')
  python3 -I "$here/summarize.py" "$label:$variant:$rules" "$debug" "$log" >> "$out" 2>&1
done
