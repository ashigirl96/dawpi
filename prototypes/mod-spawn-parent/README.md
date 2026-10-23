# PROTOTYPE: Mod が spawn した子の親 ID

捨てる前提の prototype。merge しない。問いと判定は issue [#2](https://github.com/ashigirl96/dawpi/issues/2) にある。

対象の版: Claude Code 2.1.309（macOS）。Codex は使わない。worker は `turn.step` hook が台本どおりに応答する。

## 動かし方

`mod/` を Claude Code の mod として読み込む（`claude --plugin-dir prototypes/mod-spawn-parent/mod` など）。main の Claude に `mcp__cbproto__start` を `mode` 付きで呼ばせる。ログは `/tmp/cbproto-log.json` に書かれる。

| mode | worker の動き |
|---|---|
| `tree` | Host Step 0 で `mcp__cbproto__dispatch` を呼ぶ。その `tool.call` hook が `$.agent.spawn` で子を作る。`tool.call` hook は 3 つ別々に登録してある |
| `agent-tool` | Host Step 0 で組み込みの `Agent` tool を tool chunk で呼び、子を作る（agent ごとに 1 回） |
| `throw` | `turn.step` hook が例外を出し、`.catch` は何も返さない |
| `throw-catch` | `turn.step` hook が例外を出し、`.catch` がエラー文を返して終える |

## 観測

`logs/tree.json` と `logs/agent-tool.json` が生のログ。

### `tree`（`tool.call` hook の中の `$.agent.spawn`）

- `agent.spawn` の `parentAgentId` は B・C・D すべて `null`。`$.agent.list()` にも `parentId` が無い。spawn の直後も `turn.complete` の時点も同じ。
- 深さ 4 の D も起動した（main の下 3 層の上限が効かない）。
- 子の tool call は、自分を spawn した `tool.call` 登録と、祖先を spawn した登録をまとめて飛ばす。A の呼び出しは slot 1、B は slot 2、C は slot 3 が受けた。
- `turn.step` は全員の Host Step に届き、`turn.complete` の `usage` はすべて `null`（model への request は無い）。

### `agent-tool`（`turn.step` の tool chunk で `Agent` tool）

- `parentAgentId` は B が A、C が B。`$.agent.list()` の `parentId` も同じ。
- 深さ 3 の C には `Agent` tool が渡されず、呼ぶと `No such tool available: Agent` の tool error になる。d4 は作られず、`agent.spawn` event も出ない。
- background の子が終わると、親は `agent.spawn`（`resume: { agentId }`、`parentAgentId: null`）で再開され、新しい turn の Host Step 0 から始まる。Host Step の `index` だけを見て子を spawn すると、再開のたびに spawn して止まらなくなる（実際に 500 件を超えた）。
- `turn.step` は全員の Host Step に届き、`usage` はすべて `null`。

### `throw` と `throw-catch`

この 2 つのログは mod の reload で上書きされたため、観測値をここに写す。

- `throw`: `.catch` が `{ kind: "throw", budget: 1000 }` を受けて何も返さず、本物の model（`claude-haiku-5-5`）が答えた。答えは `FALLBACK`、`usage` は input 2・output 8・cache 作成 3416 token。
- `throw-catch`: `.catch` が返したエラー文で turn が終わり、`usage` は `null`。
