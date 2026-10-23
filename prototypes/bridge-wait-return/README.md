# PROTOTYPE: 子の Run の結果を、親の Codex には保留中の bridge_wait だけで返す

捨てる前提の prototype。merge しない。問いと判定は issue [#13](https://github.com/ashigirl96/dawpi/issues/13) にある。

対象の版: Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）。main は `--model haiku`。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）と Bridge の起動引数で、`gpt-5.6-luna` の low、ephemeral thread。

## 構成

```text
main ─delegate→ Run A ─Agent(runId A)→ worker A ↔ Codex A
                                          │ bridge_delegate → Agent(runId B) → bind → {runId B, accepted}
                                          │ bridge_wait(runId B)（応答を保留）
                                          ▼
                                 worker B ↔ Codex B（最下層。dynamic tool なし）
                                          │ B-RESULT <nonce> を答え、worker B が報告して stop
                                          ▼
            Mod が B の turn.complete（終端かつ stop）を見て、保留中の bridge_wait に {runId, state, result} を返す
                                          ▼
                              Codex A が B の結果を答え、worker A が報告する
```

ticket #12 の Mod（`prototype/delegate-grandchild`）に、`bridge_wait` と次の観測を足したもの。

- Codex B には Mod だけが知る nonce を答えさせる。Codex A の回答に nonce が出れば、B の結果は `bridge_wait` の応答を通って届いた。Mod が Codex に送ったものは log の `to.codex` にすべて残る。
- worker A の Host Step ごとに、`messageCount` と `$.session.messages({ agentId, as: 'api' })` を記録し、B の報告が A の会話に入った時点を見る。
- `bridge_wait` には、B の Run が終端にあり、かつ B の `turn.complete` が来た後でだけ答える。

| variant | `bridge_wait` を保留している間の worker A |
|---|---|
| hold | Host Step を開いたまま relay を読み続ける（2 秒ごとに B の stop を確かめる）。答えた後、同じ Host Step で報告する |
| hold-probe | hold と同じ。報告の前に無害な `mcp__cbp13__status` を 1 回呼び、同じ turn に Host Step を 1 つ足す |
| yield | text で turn を終える。B の完了通知で Host Step 0 から起こされ、そこで `bridge_wait` に答える |

## 動かし方

```sh
sh prototypes/bridge-wait-return/launch.sh <hold|hold-probe|yield> <default|auto> <tmux の session 名>
```

main に「`mcp__cbp13__delegate` を task "wait" で呼び、結果の指示どおりに cbp13:worker を起動して、終わったら worker の報告をそのまま教えて」と頼む。Mod の log は `/tmp/cbp13-<variant>-<起動時刻>.json`、debug log は `/tmp/cbp13-debug-<variant>-<mode>-<起動時刻>.log`。auto mode では、試験の project（`/tmp/cbp13-work/.claude/settings.local.json`）に `Agent(cbp13:worker)` の allow rule を置く（下の run 4）。

## 観測

生のログは `logs/`。`*-worker-a-transcript.txt` は worker A の transcript の並び、`*-main-notifications.txt` は main に積まれた完了通知と hand-back、`*-debug-excerpt.txt` は debug log の抜き出し。transcript の抜き出しは home の path、user 名、email を伏せてある。

| run | mode | variant | `bridge_wait` の応答 | Codex A の回答に B の nonce | main に届いた A の結果 |
|---|---|---|---|---|---|
| 1-hold-default | manual | hold | 保留 4,974 ms、B の stop から 1,998 ms 後 | 無し（prompt の不備で `undefined`） | `already reported` だけ。報告は消えた |
| 2-hold-probe-default | manual | hold-probe | 保留 4,317 ms、B の stop から 1,983 ms 後 | あり | A の報告が 1 回 |
| 3-yield-default | manual | yield | 保留 2,530 ms、B の stop から 20 ms 後 | あり | A の報告が 1 回 |
| 4-hold-auto-denied | auto | hold | （main の `Agent` が classifier に拒否され、worker は起きない） | — | — |
| 5-hold-auto | auto | hold | 保留 3,686 ms、B の stop から 1,949 ms 後 | あり | hand-back が 1 回 |
| 6-yield-auto | auto | yield | 保留 2,987 ms、B の stop から 25 ms 後 | あり | hand-back が 1 回 |

run 1 の後に Codex A への prompt を「`result` field の値だけ」から「`bridge_wait` が返した text だけ」に直した。`gpt-5.6-luna` は code mode で文字列の `.result` を読み、`undefined` と答えていた。

- **B の結果が Codex A に届く経路は `bridge_wait` の応答だけ。** どの run でも、Mod が Codex A に送ったのは `bridge_delegate` と `bridge_wait` への応答の 2 件だけ（`to.codex`）。B の報告は A の会話に入るが、A の worker は Mod が動かしていて model を持たないので、Codex A には渡らない。
- **B の報告は、A の Host Step の境目にだけ入る。** host は B が止まった時刻に、A への通知を `queued_command` として積む（manual は `<task-notification>`、auto は B の hand-back の `<agent-message>` と `<task-notification>` の 2 件）。通知が A の会話に入るのは、A の次の Host Step の境目（run 2: `status` の tool result の後ろ）か、A の turn が終わった後の resume（run 1、3、5、6）。Host Step の途中には割り込まない。
- **manual mode では、A が子の通知を受け取らないまま stop すると、その報告は呼び出し元に届かない。** run 1 では B が止まった 3.6 秒後に A が報告して stop したが、host は A を B の通知で起こし直し、その次の stop の text（`already reported`）だけを main に届けた。run 2 では、通知が Host Step の境目で入った後の stop で、A の報告が届いた。ticket #12 で見えた「生きている background の子を持たない stop」の条件は、子の turn が終わっただけでは満たされず、子の通知を親が受け取るまで続く。
- **auto mode の `SubagentHandback` には、この条件がかからない。** run 5 では、B の hand-back と完了通知を受け取る前に A が出した `SubagentHandback` が `Report delivered to your caller` で main に届いた。B の 2 件は A の turn の後に 1 件ずつ入り、A はそのたびに起こされて text（`already reported`）で終えた。main に積まれた A の完了通知の `<result>` は「報告は hand-back で届けた」という案内に置き換わっていて、`already reported` の text は main に出ない。`SubagentHandback` の tool 呼び出しで、A の turn はそのまま終わった（次の Host Step は無い）。
- **yield では、子の stop から `bridge_wait` の応答までが 20〜25 ms。** A は B の stop から 8〜11 ms で Host Step 0 から起こされる。hold では、A の Host Step の poll の間隔（2 秒）だけ遅れる。
- **保留中の余計な model の要求は無い。** 保留は 2.5〜5 秒で、Codex の `wait` による再要求の間隔（ticket #3 では約 30 秒）より短かった。worker の `turn.complete` はすべて `usage: null`。
- **auto mode の 2 段目は、ユーザーが重ねて頼んでも拒否された（run 4）。** main の `Agent`（runId を prompt にした起動）は 1 回目が「dangerous（説明なし）」、ユーザーが起動をはっきり求めた 2 回目が `[Auto-Mode Bypass]` で拒否された。ユーザーが試験の project に `Agent(cbp13:worker)` の allow rule を置いた run 5、6 では、classifier を通らずに起動した。
- auto mode では、hook が出した Host Step の報告に「classifier が使えなかった」注記が付く（ticket #10 と同じ）。
