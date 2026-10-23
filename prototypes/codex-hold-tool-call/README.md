# PROTOTYPE: Codex の dynamic tool 呼び出しを保留する

捨てる前提の prototype。merge しない。問いと判定は issue [#3](https://github.com/ashigirl96/dawpi/issues/3) にある。

対象の版: codex-cli 0.163.0、Bun 1.4.4（macOS）。Claude Code は介さない。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）で、`gpt-5.6-luna` の low。

## 構成

`probe.ts` が `codex app-server` を stdio で子に持ち（`reconnect` だけは `--listen unix://` の server に WebSocket でつなぐ）、`thread/start` で dynamic tool `bridge_delegate` を登録する。Codex Turn の中で来た `item/tool/call` への応答を保留し、その間に起きたことを記録する。応答には毎回違う nonce を入れ、最終 message に nonce が出たら `matched: true`。

```sh
bun probe.ts <scenario> [codex app-server の追加引数...]
```

| scenario | 保留中にすること |
|---|---|
| `hold` | 1 つの app-server で 3 つの thread を並べ、30 秒・5 分・15 分保留してから答える |
| `peek` | `experimentalRawEvents` を有効にして 100 秒保留し、raw の Responses item と rollout を残す |
| `patient` | `peek` に、`wait` を `yield_time_ms: 600000` で呼ぶよう developer instructions を足して 200 秒保留する |
| `steer` | 5 秒後に `turn/steer` を送り、10 秒後に答える |
| `interrupt` | 10 秒後に `turn/interrupt` を送り、その後に遅れて答える。続けて次の Codex Turn を流す |
| `eof` | durable な thread で保留中に stdin を閉じる。新しい app-server で `thread/resume` し、次の Codex Turn を流す |
| `reconnect` | `--listen unix://` の app-server に client 1 でつなぎ、保留中に切る。client 2 で `thread/resume` して答える |

`logs/<scenario>.json` が生のログ。`peek` と `patient` は durable な thread で、rollout は Bridge 専用の `CODEX_HOME` の `sessions/` にある。

## 観測

- `hold`: 30 秒・5 分・15 分のどれも、応答を受け取って Codex Turn が `completed` になり、nonce が一致した。`dynamicToolCall` の `durationMs` は保留した時間と一致した（899997 ms など）。
- `peek`: model は `bridge_delegate` を直接呼ばない。code mode の custom tool `exec` に `await tools.bridge_delegate(...)` という JS を書いて呼ぶ。`exec` は約 31 秒で「Script running with cell ID 1」を返して model に戻り、model は `wait`（`yield_time_ms: 30000`）を呼び続ける。保留の間、約 32 秒ごとに model への request が 1 回走る。1 回あたり入力は約 12K token（半分ほどは cache）で、context は 1 回に約 67 token ずつ伸びる。15 分の保留で thread の token 合計は 348K になった。
- `--disable code_mode_host` で起動しても model は `exec` を呼び、「code-mode host is disabled」で失敗した。tool の出し方は model の側で決まっていて、app-server の設定では外せなかった。
- `patient`: developer instructions で指示すると、model は `wait` を `yield_time_ms: 600000` で呼び、`wait` は tool の応答が来た時点（167.8 秒）で戻った。200 秒の保留中の request は 2 回（最初の `exec` の 31 秒と、`wait` の 1 回）に減った。600000 ms より長い値が切り詰められるかは見ていない。
- `steer`: 保留中の `turn/steer` は即座に受理され、tool の応答の後の最終 message に反映された（`pong-<nonce> STEERED`）。
- `interrupt`: `turn/interrupt` は `{}` を即座に返し、`dynamicToolCall` は `status: failed`、`success: false` で完了し、Codex Turn は `interrupted` になった。保留中の server request の取り消しは通知されない（`serverRequest/resolved` は出ず、stderr に `dynamic tool call was cancelled before receiving a response` が出るだけ）。遅れて送った応答は、エラーも返さず黙って捨てられた。次の Codex Turn で model は前の結果を「NONE」と答えた。
- `eof`: stdio の app-server は stdin を閉じると 11 ms で終わる。保留中の呼び出しは取り消され、durable な thread には `interrupted` の Codex Turn と `dynamicToolCall: failed` が残る。新しい app-server で `thread/resume` すると thread は `idle` で、呼び出しは送り直されない。`thread/resume` に `dynamicTools` を渡さなくても、次の Codex Turn で `bridge_delegate` を呼べた（tool は thread と一緒に保存される）。
- `reconnect`: `--listen unix://` の app-server は、client が切れても Codex Turn を止めず、保留中の呼び出しも取り消さない。別の client が `thread/resume` すると、同じ `item/tool/call`（同じ `callId`、JSON-RPC の id も同じ `0`）が送り直され、それに答えると Codex Turn は `completed` になった。`thread/resume` の時点の Codex Turn は `inProgress`、`dynamicToolCall` も `inProgress` だった。
- `codex app-server proxy --sock` はバイトを素通しするだけで、stdio 側でも WebSocket の framing が要る。生の JSON 行を書くと何も返らずに終わった。Bun の `WebSocket` は `ws+unix:///path` で Unix socket につなげる。
- `serverRequest/resolved` は、どのシナリオでも 1 度も出なかった。
- 副産物: Bridge 専用の `CODEX_HOME` でも、developer message の skill 一覧に `~/.agents/skills` の個人 skill が入る（skill root `r0`）。`CODEX_HOME` の分離では外れない。
