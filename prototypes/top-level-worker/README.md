# PROTOTYPE: auto mode で Run の最上位の worker を起動する

捨てる前提の prototype。merge しない。問いと判定は issue [#11](https://github.com/ashigirl96/dawpi/issues/11) にある。

対象の版: Claude Code 2.1.309（macOS）。main は `--model haiku`。Codex は stub で、activate は Run の状態を変えるだけ（Codex との接続は #4 で確かめ済み）。

## 動かし方

```sh
sh prototypes/top-level-worker/launch.sh <A|B|C> <auto|default> <tmux の session 名>
```

`launch.sh` は `/tmp/cbp11-variant` に variant を書き、親の session の env を外した Claude Code を tmux で起動する。作業ディレクトリは `/tmp/cbp11-work`。Mod の log は `/tmp/cbp11-<variant>-<起動時刻>.json`、debug log は `/tmp/cbp11-debug-<variant>-<mode>-<起動時刻>.log` に書かれる。

| variant | 起動の形 |
|---|---|
| A | main が登録 tool `mcp__cbp11__delegate` を 5.2 の形の入力で呼ぶ。Mod は検証して Run を prepare し、runId を返す。main はその runId を prompt にして `Agent(subagent_type: "cbp11:worker")` を呼ぶ |
| B | main が `Agent` の prompt に起動入力の JSON を入れて呼ぶ。schema は worker の説明文に書く |
| C | `delegate` の `tool.call` hook の中で `$.agent.spawn` する（#4 で拒否された経路の取り直し） |

どの variant でも、Mod の `agent.spawn` hook が worker の spawn を受け、検証してから `next({ ...e, prompt: runId })` で spawn させ、返った `agentId` を Run に bind する。worker の `turn.step` は bind 済みの Run を activate し、auto mode では `SubagentHandback`、manual mode では text で一度だけ報告する。

## 観測

生のログは `logs/`。`*-debug-excerpt.txt` は debug log の抜き出し。

- **C は auto mode で通らない**: ユーザーが起動をはっきり求めても、2 回とも `$.agent.spawn` が `{ deny: "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. ..." }` を返した。審査は server 側の classifier が model の API 応答の上で行い、hook が出した spawn には審査する応答が無い。
- **A と B は auto mode で通る**: main の model が出した `Agent` の呼び出しは審査を通った（`permissionDecisionMs` 302・341）。
- **bind の順序**: 4 回の spawn のすべてで、`agent.spawn` の `next` は 11〜18 ms で解決し、worker の Host Step 0（解決から 12〜15 ms 後）より先に bind が済んだ。会話から runId を探す予備の経路は一度も使われなかった。`parentAgentId` は無し（main）で、`permissionMode` は親のもの（`auto` / `default`）が見えた。
- **A の拒否**: 存在しない runId と報告済みの runId で `Agent` を直接呼ぶと、`agent.spawn` の deny が `Subagent spawn denied by a plugin: ...` の tool error として main に届いた。
- **inputSchema は engine が検証しない**: `additionalProperties: false` の schema に対し、未知の `env` を文字列で付けた呼び出しがそのまま Mod の `tool.call` に届いた。弾いたのは Mod の検証器。
- **B の拒否と再試行**: effort に `ultra` を指定させると、`agent.spawn` の deny（`$.execution.effort: one of low, medium, high, xhigh`）を読んだ main が `xhigh` に直して再試行し、通った。
- **main の Host Step**: A は delegate の後に main の Host Step が 1 回増える（約 4 秒）。B は増えない。
- **manual mode（A）**: 同じ経路で通り、報告は text で main に届いた。このとき main（Haiku）は、ユーザーが指定していない `approvalPolicy: "never"` を自分で入力に加えた。
- worker の Host Step はすべて `usage: null` で、余計な model の要求は無い。
- C で prepare した Run は spawn が拒否されたまま `prepared` で残った。

## 記録

最初の起動では、`$` を `register` の中で定義した関数に渡していたため、Mod が読み込まれなかった（Mod は file の最上位で宣言した関数にしか `$` を渡せない）。その session の main は、Mod の tool が無いまま、Bash で既定の CODEX_HOME の `codex exec` を `gpt-5.6-luna` で直接起動し、README を読ませた（読み取りだけで、sandbox は read-only）。
