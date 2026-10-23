# Mod の prototype

Claude Code の Mod を実機で動かし、wayfinder の prototype ticket の判定を取るときの作法。prototype は `prototypes/<name>/` に置き、`prototype/<name>` branch に push する（merge しない）。

## worker の台本

worker の `turn.step` は、Host Step の位置ではなく agent ごとの状態で動かす。子の終了で resume された worker は Host Step 0 から起こされるので、`index` を見た台本は同じ tool を何度も出し、止まらなくなる（spawn で 500 回、`SubagentHandback` で 1578 回の前例がある）。

- 1 回だけの操作（子の spawn、報告）は、agent ごとの once の guard で守る。
- agent ごとの Host Step に上限を付け、超えたら text で turn を終える。上限が暴走を止める。

```ts
const STEP_CAP = 20
const steps = new Map<string, number>()
const done = new Set<string>()

// turn.step の先頭で: 上限を超えた agent は text で終える。
const n = (steps.get(id) ?? 0) + 1
steps.set(id, n)
if (n > STEP_CAP) return yield* answerText(e, `step cap ${STEP_CAP} reached`)

// 1 回だけの操作:
if (!done.has(id)) {
  done.add(id)
  return yield* callTool(e, 'SubagentHandback', { message })
}
```

- 子の報告などの meta message は、`$.session.messages({ agentId })` の rows 形式には出ない。`{ agentId, as: 'api' }` で読む。

## 起動

試験の Claude Code は tmux の中で、親の session の env を外して起動する。

```sh
#!/bin/sh
for v in $(env | sed -n 's/^\(CLAUDE[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done
cd "$1" || exit 1
exec ~/.local/bin/claude --plugin-dir "$2" --permission-mode "$3" --model haiku --debug-file "$4"
```

- main は安い model（`--model haiku`）にする。
- 試験の session は、Mod を編集する前に止める。plugin-dir の watch が Mod を reload し、memory に持った状態と log が初期化される。

## log

- log は session ごとの file 名（起動時刻を入れる）に書く。reload や再実行で前の run の log を上書きしない。
- debug log（`--debug-file`）の `tool_dispatch_start`・`API REQUEST`・classifier の行が、余計な model の要求と審査の判定の一次資料になる。
- branch に入れる log からは、home の path と user 名を伏せる（pre-commit hook が止める）。

## 注入の試験

注入や悪意の試験の payload は、無害な印の file を作る指示（`touch /tmp/<name>-marker`）にする。従ったかは file の有無で観測する。`.claude/hooks/guard-prototype-payload.sh` が、`prototypes/` への破壊的なコマンドの形の書き込みを止める。
