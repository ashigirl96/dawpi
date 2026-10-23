# PROTOTYPE: 保留中の bridge_delegate を親 worker の Agent 呼び出しにつなぎ、孫まで委譲する

捨てる前提の prototype。merge しない。問いと判定は issue [#12](https://github.com/ashigirl96/dawpi/issues/12) にある。

対象の版: Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）。main は `--model haiku`。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）と Bridge の起動引数で、`gpt-5.6-luna` の low、ephemeral thread。

## 構成

```text
main ─delegate→ Run A を prepare ─Agent(runId A)→ worker A ↔ Codex A
                                                     │ bridge_delegate（応答を保留）
                                                     ▼
                          Mod が Run B を prepare し、A の Host Step が Agent(runId B) の tool chunk を返す
                                                     ▼
                          agent.spawn hook が runId と caller を検問し、next の agentId で bind
                                                     ▼
                          保留していた A の item/tool/call に {runId B, accepted} を返す
                                                     ▼
                                     worker B ↔ Codex B → 同じ経路で C → C は D を頼む（host の上限で失敗）
```

- `mod/relay.ts`: `codex app-server` を stdio で持ち、Mod に HTTP over Unix socket で出す（ticket #4 の relay に、Bridge の `CODEX_HOME` と起動引数を足したもの）。1 つの relay の上で全 Run の Codex を動かし、event は `threadId` で振り分ける。
- `mod/hooks/register.ts`: worker の `turn.step` は Run の状態だけで動く。未配送の制御操作があれば `Agent` を返す。Codex Turn が動いていれば、Run ごとの cursor から event を読む。`bridge_delegate` が来たら子の Run を prepare して `Agent` を返す。Codex Turn が終わっても子の Run が終わっていなければ、text で turn を終えて待つ。子が全部終わったら一度だけ報告する（manual mode は text、auto mode は `SubagentHandback`）。
- Codex への指示は深さごとに固定: 「`bridge_delegate` を `{"task":"level <n+1>"}` で 1 回呼び、返った text だけを答える」。

## 動かし方

```sh
sh prototypes/delegate-grandchild/launch.sh <normal|mismatch> <default|auto> <tmux の session 名>
```

main に「`mcp__cbp12__delegate` を task "chain" で呼び、結果の指示どおりに進めて、終わったら報告を教えて」と頼む。Mod の log は `/tmp/cbp12-<variant>-<起動時刻>.json`、debug log は `/tmp/cbp12-debug-<variant>-<mode>-<起動時刻>.log`。

| variant | 動き |
|---|---|
| normal | caller を正しく記録する |
| mismatch | Codex B が頼んだ Run C の caller を、わざと A の worker として記録する。B の worker の `Agent` は caller の検問で拒否されるはず |

## 観測

生のログは `logs/`。`*-debug-excerpt.txt` は debug log の抜き出し、`*-main-notifications.txt` は main の会話に入った完了通知。

| run | 内容 |
|---|---|
| 1-normal-default | 最初の台本。worker の `tools` が `['Agent']` だけで、子を待たずに報告した |
| 2-normal-default | 台本を直した後の manual mode。A → B → C、C は D を頼んで失敗 |
| 3-mismatch-default | caller の検問の試験 |
| 4-normal-auto | auto mode。1 回目の main の `Agent` は classifier に拒否され、ユーザーがはっきり求めた 2 回目で通った |

- **保留 → `Agent` → bind → 応答は孫まで動く**: B の `parentAgentId` と `$.agent.list()` の `parentId` は A の worker、C のものは B の worker。`item/tool/call` を受けてから応答するまで 11〜51 ms（`Agent` の dispatch から bind まで 12〜35 ms）。応答の後、Codex A・B の Codex Turn は `completed` まで続いた。manual mode・auto mode とも同じ。
- **host の深さ上限（G05）**: depth 3 の C の worker が出した `Agent` は `No such tool available: Agent` の tool error になり、`agent.spawn` は起きない。Mod は C の次の Host Step で、子の Run D が `prepared` のままであることから失敗を知り、Codex C の保留中の呼び出しに `success: false` を返した。Codex C はそのまま Codex Turn を終えた。
- **caller の検問（mismatch）**: B の worker の `Agent` は `agent.spawn` の deny で止まり、`Subagent spawn denied by a plugin: ...` の tool error が B の worker に返った。Mod は deny と同時に Codex B の保留中の呼び出しに失敗を返し、Codex B はその文面を答えて Codex Turn を終えた。
- **worker の tools が空になると起動しない（run 1）**: `tools: ['Agent']` の worker を depth 3 で起こすと、`Agent` が外れて tools が空になり、engine が「Agent 'cbp12:worker' would be spawned with zero tools — refusing」で起動を拒んだ。それでも `agent.spawn` の `next` は `agentId` を返したので、Codex B には `accepted` が返った。C の `turn.complete`（`reason: "error"`）は、`next` が解決するより先に届いた。
- **報告は子が全部止まった後の stop でしか届かない（run 1 と 2）**: 完了通知の注記は「A task-notification fires each time this agent stops with no live background children of its own」。run 1 では、B が生きている間に A が出した報告の text は main に届かず、B の終了で resume された A の最後の text（`already reported`）だけが届いた。子を待ってから報告する run 2 では、A の報告が 1 回だけ届いた。待っている間の text（`waiting for 1 child run(s)`）は main に届いていない。
- **resume**: 子が終わると、親は `agent.spawn`（`resume`、`parentAgentId` は無し）で Host Step 0 から再開された。auto mode では、親は子の `SubagentHandback` と完了通知の 2 回で起こされる。2 回目は Run の状態が `reported` なので、Mod は text（`already reported`）で終えた。main に届いた A の報告は hand-back の 1 回だけ。
- **auto mode の審査**: worker が tool chunk で出した `Agent` は、Mod の `tool.check` の allow で 2〜4 ms で通った（`ask -> allow by plugins cc-plugin-sec-default, cbp12`）。classifier は関わらない。main の `Agent`（2 段目）は、1 回目が 10.9 秒かけて `[Create Unsafe Agents]` で拒否された。ユーザーが起動をはっきり求めた 2 回目は 476 ms で通った。
- **余計な model の要求は無い**: worker の `turn.complete` はすべて `usage: null`。debug log の `API REQUEST` は main・session title・prompt suggestion だけ。
- どの run でも、worker の `Agent` の dispatch で「cbp12: tool.check bypassed by cc-plugin-sec-default」が debug log に出た（画面にも注記が出た）。manual mode では `Agent` に許可が要らないので、判定の行は無いまま通った。auto mode では同じ dispatch の判定が `ask -> allow by plugins cc-plugin-sec-default, cbp12` で、Mod の allow は効いている。
