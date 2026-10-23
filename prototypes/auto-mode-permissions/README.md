# PROTOTYPE: auto mode で、最上位の worker の起動と呼び鈴の Bash はどう判定されるか

捨てる前提の prototype。merge しない。問いと判定は issue [#15](https://github.com/ashigirl96/dawpi/issues/15) にある。

対象の版: Claude Code 2.1.309（macOS）。main は `--model haiku`、`--permission-mode auto`。Codex は動かさない（worker は呼び鈴を鳴らして報告するだけ）。

測った環境: ユーザーの `~/.claude/settings.json` には、別の repo 用の `autoMode.environment`（信頼する repo や秘密の置き場所などの前提）と `autoMode.soft_deny` が入っている。`autoMode` の list は user と `--settings` で連結されるので、試験では外せなかった。classifier の判定はこの前提の上で測っている。

## 構成

- `mod/`: Mod `cbp15`。`delegate`（Run を用意して runId を返す）、`cbp15:worker`、`status` を登録する。worker は Host Step 0 で呼び鈴（`Bash({ command: "cat <FIFO>", run_in_background: true })`）を返し、通れば鳴らして、auto mode では `SubagentHandback` で報告する。呼び鈴の FIFO は Bridge と同じく home の下（`~/.cbp15-proto/bells/`）に置く。
- `trial.sh <variant> <rules> <label>`: 新しい Claude Code を tmux で起動し、依頼を送り、main が落ち着くまで待って止める。
- `batch.sh`、`summarize.py`: 試行を続けて流し、debug log と Mod の log から判定を抜き出す。

variant:

| variant | Mod の振る舞い | 依頼文と description |
|---|---|---|
| plain | `delegate` と `status` だけを `tool.check` で許可する | 「cbp15 の delegate を使って、Codex に README.md を 1 行で要約させて」。Bridge らしい description |
| proto | plain と同じ | ticket #13・#14 と同じ文面（「`mcp__cbp15__delegate` を task "wait" で呼び、…cbp15:worker を起動して」、description に PROTOTYPE と「Never launch it on your own」） |
| hookallow | plain に加え、prepared な runId を prompt にした main の `Agent` と、自分の FIFO を読む呼び鈴を `tool.check` で許可する | plain と同じ |
| gate | hookallow に加え、`delegate` の `tool.call` で先に `next(e)` を呼び、host の権限の判定に回してから答える | plain と同じ |

rules:

| rules | 置いたもの |
|---|---|
| none | なし |
| local-agent | 試験の project の `.claude/settings.local.json` に `Agent(cbp15:worker)` |
| flag-agent | `--settings` の file に `Agent(cbp15:worker)` |
| local-bell-bash | local に `Bash(cat ~/.cbp15-proto/bells/*)` |
| local-bell-bash-read | local に上の Bash と `Read(//~/.cbp15-proto/bells/**)`（実際は home の絶対 path） |
| flag-automode-allow | `--settings` の file に `autoMode.allow: ["$defaults", "<起動と呼び鈴を許す文章>"]` |

## 観測

生のログは `logs/`。`<trial>-debug-excerpt.txt` は debug log の判定に関わる行、`<trial>-mod.json` は Mod の log、`summaries.json.txt` は `summarize.py` の出力。home の path と user 名は伏せてある。

| trial | variant | rules | main の `Agent` | 判定した者 | 呼び鈴の Bash |
|---|---|---|---|---|---|
| t01〜t05 | plain | none | 通る（260〜348 ms） | server 側の classifier | 拒否 |
| t06 | plain | local-agent | 通る（338 ms）。rule は無視された | server 側の classifier | 拒否 |
| t07 | plain | flag-agent | 通る（303 ms）。rule は無視された | server 側の classifier | 拒否 |
| t08 | plain | local-bell-bash | 通る（430 ms） | server 側の classifier | 拒否 |
| t09 | plain | local-bell-bash-read | 通る（351 ms） | server 側の classifier | 通る（rule） |
| t10、t11 | plain | flag-automode-allow | 通る（154、273 ms） | server 側の classifier | 拒否 |
| t12、t13 | hookallow | none | 通る（507、332 ms） | server 側の classifier（Mod が入力を読み違え、許可しなかった） | 拒否 |
| p01〜p06 | proto | none | 通る（4,642〜8,009 ms） | server 側の classifier | 拒否 |
| pa01〜pa04 | proto | flag-automode-allow | 通る（242〜477 ms） | server 側の classifier | 拒否 |
| h01、h02 | hookallow | none | 通る（3、4 ms） | Mod の `tool.check` | 通る（Mod） |
| g01〜g04 | gate | none | 通る（3〜5 ms） | Mod の `tool.check` | 通る（Mod） |

- **auto mode では、`Agent(...)` の allow rule はどの層に置いても捨てられる。** debug log に `Ignoring dangerous permission Agent(cbp15:worker) from .claude/settings.local.json (bypasses classifier)`（t06）、`… from ../cbp15/flag-settings.json …`（t07）と出る。本体（2.1.309）では、auto mode に入るときに allow rule を全ての出どころ（user・project・local・flag・managed・CLI 引数・session）から集め、tool 名が `Agent` のものを内容に関わらず「dangerous」として外す。`Bash` は `python`・`sh`・`env` などの interpreter を許す rule だけが外れ、`Bash(cat …)` は残る。
- **main の `Agent` は 29 回とも通り、拒否は再現しなかった。** ただ、ticket #13・#14 の文面（proto）では判定に 4.6〜8.0 秒かかり、新しい文面（plain）の約 0.3 秒より大きく遅かった。どちらも local の classifier は動いておらず（`classifier_request_started` が無い）、main の model の応答に付く server 側の判定で決まっている。ticket #13 の run 4 の拒否（`judged this action dangerous`、11 秒）も、この遅い判定の側で起きた。ticket #13 の run 5・6 と ticket #14 の run 6 も 4.3 秒、5.9 秒かけて classifier を通っていて、「allow rule で classifier を通らずに起動した」は誤りだった。
- **`autoMode.allow` の文章の rule は判定を速くした。** proto の文面でも 242〜477 ms で通った。`autoMode` は user・flag・managed の設定からしか読まれない（project と local は `settings autoMode in … ignored` で捨てられる）。`"$defaults"` を入れないと組み込みの allow の rule が外れる。
- **呼び鈴の Bash は、rule も Mod の許可も無いと拒否される。** `Error: The server-side auto mode classifier gave no verdict for Bash: the request that produced this action did not ask for one.`、debug log では `Auto mode classifier unavailable, denying with retry guidance (fail closed)`。Mod が作った Host Step には server 側の判定が付かず、local の classifier にも回らない。`Bash(cat <dir>/*)` だけでは、組み込みの path の検査（作業 directory の外の `cat`）が ask を返して同じく拒否された。`Read(<dir>/**)` も置くと通った（t09）。`autoMode.allow` の文章では通らない（t10、t11）。
- **auto mode では、Mod の `tool.check` の許可が classifier を経ずに採られる。** debug log は `tool.check Agent …: ask -> allow by plugins cc-plugin-sec-default, cbp15`。main の `Agent` も worker の呼び鈴も 3〜6 ms で通った。同時に `cbp15: tool.check bypassed by cc-plugin-sec-default (tier user); beneath runs` と `$.ui.log: its tool.check hook was skipped` が出て、main の会話にこの通知が入る。main は毎回それをユーザーに伝えた。manual mode で Mod の `tool.check` が飛ばされる件（ticket #14）とは逆の結果。
- **Mod の `tool.call` が `next()` を呼ばずに答えると、その tool の権限の判定は走らない。** plain から hookallow まで、`delegate` は `resolved by a hooks module (result)` だけで、`tool.check` も classifier も通っていない（Mod の `tool.check` の allow も実は使われていなかった）。gate で先に `next(e)` を呼ぶと、`tool.check` が `ask` を返し、約 300 ms で server 側の判定を通った。`next()` の先では登録した tool の実体が無く、`no tool.call hook answered this call` の ERROR が log に出るが、Mod はそれを捨てて自分の結果を返せる。
- Mod の `tool.check` は、event に呼び出しの入力を `input` で受ける。`tool.call` は入力を event に広げて受ける（t12、t13 はこの読み違いで許可が効かなかった）。

classifier が危険な task の `delegate` を止めるかは確かめていない。そのための依頼文は、repo の `.claude/hooks/guard-prototype-payload.sh` が payload として止めた。

## 動かし方

```sh
sh prototypes/auto-mode-permissions/batch.sh <out file> <label>:<variant>:<rules> ...
```

各試行の screen は `/tmp/cbp15-screen-<label>-<起動時刻>.txt`、debug log は `/tmp/cbp15-debug-<label>-<起動時刻>.log` に残る。
