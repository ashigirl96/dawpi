# PROTOTYPE: bridge_wait を保留して寝ている親 worker を、Codex の新しい bridge_delegate のために起こす

捨てる前提の prototype。merge しない。問いと判定は issue [#14](https://github.com/ashigirl96/dawpi/issues/14) にある。

対象の版: Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）。main は `--model haiku`。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）と Bridge の起動引数で、`gpt-5.6-luna` の low、ephemeral thread。

## 構成

ticket #13 の Mod（`prototype/bridge-wait-return`、yield の variant）に、次を足したもの。

- `bridge_wait` に `timeoutMs` を足した。期限が来たら、Supervisor（Mod）は Host Step を使わずに `{runId, state: "pending"}` で答える。
- worker が寝ている間（yield の後）は、Host Step の外の watch が Codex の event を読む。期限切れの `bridge_wait` に答え、Host Step が要る要求（新しい `bridge_delegate`、Codex Turn の終わり）が来たら worker を起こす。
- 子の Run は task に `slow` を含むと、Codex を起動する前に 20 秒止まる。

シナリオ（Codex A への指示）:

| scenario | Codex A の手順 |
|---|---|
| pending | slow を委譲 → `bridge_wait(timeoutMs 3000)` が `pending` → fast を委譲 → fast と slow を順に `bridge_wait` |
| parallel | slow を委譲 → `bridge_wait` を await せずに始め、その間に fast を委譲 → 両方を待つ |

起こし方（waker）:

| waker | 寝ている間の `bridge_delegate` |
|---|---|
| send | Mod が `$.session.send({ to: { agentId } })` で worker に message を送る |
| bell | 寝る前に worker の Host Step が `Bash({ command: "cat <FIFO>", run_in_background: true })` を返しておく（呼び鈴）。Mod が FIFO に書くと `cat` が終わり、host がその完了通知で worker を起こす |
| refuse | 失敗で返し、「先に全部 bridge_delegate してから bridge_wait する」よう伝える |

## 動かし方

```sh
sh prototypes/wake-sleeping-parent/launch.sh <scenario>-<waker> <default|auto> <tmux の session 名>
```

main に「`mcp__cbp14__delegate` を task "wake" で呼び、結果の指示どおりに cbp14:worker を起動して、終わったら worker の報告をそのまま教えて」と頼む。Mod の log は `/tmp/cbp14-<scenario>-<waker>-<起動時刻>.json`、debug log は `/tmp/cbp14-debug-<scenario>-<waker>-<mode>-<起動時刻>.log`。bell では、試験の project（`/tmp/cbp14-work/.claude/settings.local.json`）に `Bash(cat /tmp/cbp14/bell-*)` と `Read(//private/tmp/cbp14/**)` の allow rule を置く。auto mode では `Agent(cbp14:worker)` も置いた（下の「allow rule」を参照）。

## 観測

生のログは `logs/`。`*.json` は Mod の log、`*-main-notifications.txt` は main の会話に入った完了通知と hand-back、`*-debug-excerpt.txt` は debug log の抜き出し。home の path と user 名は伏せてある。

| run | mode | scenario-waker | 寝ている間の `bridge_delegate` への応答 | main に届いたもの |
|---|---|---|---|---|
| 1-pending-send-default | manual | pending-send | 起こした turn は Haiku が答え、Mod の hook は動かなかった。応答は 17,769 ms 後（slow の子の通知で起きた turn） | 報告 1 回 |
| 2-pending-bell-default-prompted | manual | pending-bell | （allow rule が無く、呼び鈴の Bash が承認待ちで止まった） | — |
| 3-pending-bell-default-early-report | manual | pending-bell | 呼び鈴から 9 ms で起き、41 ms で答えた | 途中経過の通知（報告入り）と `already reported` の 2 回。Mod の bug |
| 4-pending-bell-default-interim | manual | pending-bell | 35 ms で答えた | 途中経過の通知と報告の 2 回 |
| 5-pending-bell-default | manual | pending-bell | 呼び鈴から 10 ms で起き、38 ms で答えた | 報告 1 回 |
| 6-pending-bell-auto | auto | pending-bell | 37 ms で答えた | hand-back 1 回 |
| 7、8-parallel-bell-default | manual | parallel-bell | （Codex が `bridge_wait` の応答を待ってから委譲し、寝ている間の要求は起きなかった） | 報告 1 回 |
| 9-pending-refuse-default | manual | pending-refuse | 断ると Codex は 1 回だけ再試行し、作業を諦めた | 失敗の報告 |

- **Mod の `$.session.send` で起こした turn では、Mod 自身の hook が動かない（run 1）。** 起こした turn は Mod の呼び出しの中に入れ子になり、debug log に `cbp14@inline turn.step skipped: re-entry (the plugin's own code raised it; origin cbp14)` と出る。`agent.spawn` と `tool.check` も同じ。worker は本物の model（Haiku、`source=agent:custom:cbp14:worker`、output 883 tokens）で動き、会話を読んで「delegate の runId が無いので起動しない」と答えた。worker は `Agent` を持っていたので、子を起こすこともできた。型宣言の「呼んだ hook だけが外れる」とは違い、その呼び出しから起きた turn の中では plugin の hook がすべて外れた。
- **呼び鈴の完了通知で起きた turn では、Mod の hook が Host Step 0 から動く（run 5、6）。** 呼び鈴の Bash は worker 自身の tool 呼び出しで、host が完了を通知して worker を起こす。起きた Host Step で `Agent` の tool chunk を返し、`agent.spawn` で bind して保留中の `bridge_delegate` に答える経路（ticket #12）がそのまま通った。worker の model の要求は無い（`source=agent:custom` が 0 件、`turn.complete` はすべて `usage: null`）。
- **manual mode では、呼び鈴の Bash を Mod が許可できない（run 2）。** 組み込みの `cc-plugin-sec-default` が先に Bash を判定し、Mod の `tool.check` は飛ばされる（`its tool.check hook was skipped`）。`Bash(cat /tmp/cbp14/bell-*)` の rule だけでは承認を求められ、FIFO を読む path の `Read(//private/tmp/cbp14/**)` も要った。auto mode では Bash の判定は 2〜4 ms で済んだ（classifier の審査なし）。
- **呼び鈴だけが生きている状態で worker が stop すると、呼び出し元に途中経過の通知が届く（run 3、4）。** 生きている子の agent が無く、background の Bash だけが残っていると、host は `Agent "cbp14 d1" is waiting on its own background work` の通知に stop した text を入れて main に届ける（「result below may be interim」）。子の agent が生きている間の stop では届かない（ticket #13 と同じ）。報告の前に呼び鈴を鳴らし、stop せずに `mcp__cbp14__status` を呼んで Host Step を進め、呼び鈴の完了通知を会話に受け取ってから報告すると、main には報告が 1 回だけ届いた（run 5、6。Host Step を 1〜2 回足した）。
- **呼び鈴の完了通知は、子の通知と同じく worker の会話に入る。** `<summary>Background command "cbp14 doorbell" completed (exit code 0)</summary>`。Bash の tool result にも task-notification という語があるので、完了の判定は summary で行った。
- **Codex は dynamic tool の呼び出しを重ねなかった（run 7、8）。** 「`bridge_wait` を await せずに始め、その間に `bridge_delegate`」と指示しても、2 つ目の `bridge_delegate` は `bridge_wait` の応答の 1 ms 後に届いた。寝ている間に新しい要求が来るのは、期限付きの `wait` が `pending` で返った後（scenario pending）だけだった。
- **断ると、Codex は作業を諦めた（run 9）。** `gpt-5.6-luna` は同じ `bridge_delegate` を 1 回再試行し、`Unable to complete: step 3 was refused` と答えた。手順を固定した指示なので、指示の書き方で変わりうる。
- **auto mode の `Agent(cbp14:worker)` の allow rule は無視されていた（run 6）。** debug log に `Ignoring dangerous permission Agent(cbp14:worker) from .claude/settings.local.json (bypasses classifier)` と出る。main の `Agent` は `permissionDecisionMs=5937` で、classifier の審査を通って起動した。ticket #13 の run 6 の debug log にも同じ行がある。

run 9 の refuse は、Codex Turn の終わりで worker を `$.session.send` で起こしたので、起きた turn は run 1 と同じく model が答えている（worker の定義の prompt どおり `FALLBACK`）。refuse の観測は Codex の振る舞いだけに使う。
