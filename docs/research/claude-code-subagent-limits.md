# Claude Code の subagent の上限と hook の予算は、Mod の spawn と待ちにどう効くか

調査日: 2026-10-23。対象: Claude Code 2.1.309。issue #5 への回答。設計書 v1 の 7、8.4、9.2 と、検証ゲート G05・G08 の前提にあたる。

## 根拠の確度

各回答に次のラベルを付ける。

- **一次資料で確定**: 公式ドキュメントか型宣言に、そのまま書いてある。
- **宣言からの推論**: 書いてあることを組み合わせると導けるが、その組み合わせ自体は書かれていない。
- **不明（実機が必要）**: 資料からは決まらない。

## 一次資料

- **型宣言**: Claude Code 同梱の plugin-authoring skill の型宣言 `types/claude-code.d.ts`（1 行目が `// Written by Claude Code 2.1.309.`）と、同じ skill の `reference.md`。以下 `d.ts:行`、`reference.md:行` と書く。行番号は 2.1.309 が書き出した版のもの。GitHub の `mods/types/claude-code.d.ts` は版が古いことがあり、行番号も合わない。
- **公式ドキュメント**（2026-10-23 に取得）
  - [Create custom subagents](https://code.claude.com/docs/en/sub-agents)（以下 sub-agents）
  - [Environment variables](https://code.claude.com/docs/en/env-vars)（以下 env-vars）
  - [Tools reference](https://code.claude.com/docs/en/tools-reference)（以下 tools-reference）
  - [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)（以下 mods/reference。冒頭に「as of v2.1.290」とある）
  - [React to events with a mod](https://code.claude.com/docs/en/plugins/mods/events)（以下 mods/events）
  - [Use the mods API](https://code.claude.com/docs/en/plugins/mods/api)（以下 mods/api）

## 結論の要約

| # | 問い | 答え | 確度 |
|---|---|---|---|
| 1a | 深さの上限 | main の下に 3 層。`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` で変えられるが、上限を外すことはできない | 一次資料で確定 |
| 1b | 同時実行数の上限 | session 内で同時に running なのは 20 まで。`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` で変えられる。上限に当たると spawn は即座に失敗し、queue には入らない | 一次資料で確定 |
| 1c | `$.agent.spawn` も同時実行数に数えられるか | 数えられ、同時実行数の上限で止められる | 宣言からの推論 |
| 1d | `$.agent.spawn` に深さの上限が効くか | 資料からは決まらない | 不明（実機が必要） |
| 1e | 上限に当たったときの戻り値 | reject ではなく `{ deny: reason }` で resolve する。理由の文言は資料に無い | 形は一次資料で確定、文言は推論 |
| 2a | module 内の Promise を待つ時間は 10 秒の予算に数えられるか | 数えられる | 一次資料で確定 |
| 2b | 予算を減らさずに長く待つ方法 | 待つ時間を `$` の呼び出し（`$.clock.sleep` を除く）か `next` の中に置く。実際には、Supervisor への `$.http.fetch`（1 回 30 秒まで）を繰り返す | 原則は一次資料で確定、組み立て方は推論 |
| 3 | `turn.step` で駆動する agent から `SubagentHandback` を使えるか | 道具は渡る見込みが高い。ただし渡るのは auto mode のときだけで、interactive かどうかでは決まらない。hook が作った tool call で実際に配送できるかは資料に無い | 条件は一次資料で確定、使えるかは不明（実機が必要） |

別に、設計書 7.3 の再帰経路を崩しかねない事実が見つかった。Mod が `$.agent.spawn` で起動した子の tool call は、spawn を呼んだ hook を飛ばす（[付記 A](#付記-a-spawn-した-hook-は子のイベントを受け取らない)）。

---

## 1. subagent の深さと同時実行数の上限

### 1a. 深さ: main の下に 3 層（一次資料で確定）

- sub-agents の「Let subagents spawn their own subagents」より。「By default, a subagent can spawn subagents of its own, up to three layers below the main conversation. At the depth limit, Claude Code withholds the `Agent` tool from every subagent except a fork, so a subagent at the limit does its delegated work itself and returns one summary. A fork at the limit keeps `Agent` in its inherited tool list, but the tool returns an error instead of spawning.」
- env-vars の `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` より。既定は 3 で、`1` にするとネストが止まる。「Accepts a positive whole number in plain digits; anything else is ignored, so the limit can be adjusted but not removed.」v2.1.217 以降の変数で、v2.1.219 から既定が 3 になった。
- 上限は 2 つの仕組みで守られている。1 つは model に `Agent` tool を見せないこと。もう 1 つは呼び出し時の検査で、fork が上限で `Agent` を呼ぶとエラーになることからわかる。

### 1b. 同時実行数: 20（一次資料で確定）

- sub-agents の「Concurrent subagent limit」より。「By default, when 20 subagents are running in a session, spawning another with the Agent tool fails with `Concurrent subagent limit reached`, and the error tells Claude not to retry. Spawning succeeds again when the running count drops below the limit.」
- 同じ節より。「The limit blocks only subagents Claude spawns with the Agent tool, but other runs occupy the same slots」。`/subtask` の fork は枠を占めるが止められない。終わった subagent を resume すると、上限を確かめずに新しい枠を取る。
- 同じ節より。「Agents that other features run, such as workflow agents and agent team teammates, follow their own limits instead.」ultracode が有効な session には上限が無い。
- env-vars より。`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` は正の整数で、上限を変えられるが無効にはできない。session あたりの総数の上限 `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` は v2.1.224 で無くなった。
- 上限に当たった spawn は待たされずにすぐ失敗する。queue に入るという記述はどこにも無い。

### 1c. `$.agent.spawn` も同時実行数に数えられる（宣言からの推論）

- `d.ts:3254-3262`（`$.agent.spawn`）より。「the same call the engine makes when the Agent tool starts one」「then the Agent tool in the background under this call's origin」「`{ deny }` is a hook's refusal, or the engine's own with its reason: past a Stop or a host's limit nothing is spawned」。
- `d.ts:248-249`（`AgentSpawnArgs`）より。「A call's spawn runs in the background: it resolves once the subagent started」。
- sub-agents は、同時実行数の上限が止めるのは「Agent tool で spawn した subagent」だと書いている。Mod の spawn も中では Agent tool を通る（`d.ts:3257-3258`）。したがって Mod の spawn も枠を 1 つ使い、上限に当たれば止められる、と読める。ただし Mod からの spawn を名指しした記述は無い。
- `AgentInfo.spawnedBy`（`d.ts:169-175`）が spawn した plugin を記録している。Mod が起動した agent も、session の agent 一覧（`$.agent.list()`）に同じように並ぶ（`d.ts:3268-3276`）。

### 1d. `$.agent.spawn` に深さの上限が効くか（不明（実機が必要））

- 深さの上限は、主に model から `Agent` tool を隠すことで守られている（1a）。`$.agent.spawn` は model の tool 一覧を通らないので、この仕組みは効かない。
- 一方、呼び出し時の検査もある（上限にいる fork の `Agent` はエラーを返す）。`$.agent.spawn` は Agent tool を通るので、この検査が効いて `{ deny }` になる可能性がある。
- 親子関係そのものは host が記録している。`AgentSpawnInput.parentAgentId` は「The id of the loop the spawn happens in (its `tool.call` `agentId`...)」で、値は固定され、書き換えると拒否される（`d.ts:313-321`）。`AgentInfo.parentId` もある（`d.ts:164-168`）。深さを数える材料は host 側にそろっている。
- **設計への影響**: 9.2 の `maxDepth` は、ホストの上限 3 を超えない値にしておけば、どちらの挙動でも安全である。G05 では、深さ 3 の worker から `$.agent.spawn` を呼び、`{ deny }` が返るのか起動してしまうのかを確かめる。

### 1e. 上限に当たったときの戻り値（形は一次資料で確定、文言は推論）

- `AgentSpawnResult`（`d.ts:411-458`）は `{ model, agentId?, teammateId? }` か `{ deny: string }` のどちらかである。`d.ts:3261-3262` は、host の上限による拒否も `{ deny }` で返ると明記している。
- mods/api の「What refused calls return」より。ユーザーが中断した直後の `$.agent.spawn` は「Resolves with `{ deny: '<reason>' }` and starts no subagent」。reject ではなく resolve する例の 1 つである。
- 同時実行数の上限での `deny` の文言は、Agent tool のエラー `Concurrent subagent limit reached` になると推測できる。ただし資料には無い。設計書 9.3 の `CAPACITY_EXHAUSTED` に対応させるなら、文字列の一致には頼らず、`deny` が返ったことを `agent.list()` の running 件数と突き合わせて分類するのがよい。

### 補足: 枠を占める時間

- sub-agents より。「Interactive terminal session: only the top-level subagent's summary returns to you, because a subagent that launches background subagents waits for their results before it finishes.」子の結果を待っている親も running のまま枠を占める。設計書 9.1 の「ネイティブ Agent のスロットはホストの数え方に従う」と合っている。
- Mod の spawn で親になった worker（`parentAgentId` が worker の loop）が、子の終わりまで終われないかどうかは書かれていない（不明（実機が必要））。
- env-vars の `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` より。subagent が止まったとみなされるまでの時間で、既定は 10 分。`turn.step` を Mod が答える worker が Codex を長く待つ場合に、これが当たるかは資料に無い（不明（実機が必要））。

---

## 2. hook の予算（10 秒）と長い待ち

### 2a. module 内の Promise を待つ時間は数えられる（一次資料で確定）

- mods/events の「Hold a tool call until the user decides」より。「Keep the wait inside a mods API call such as `$.ui.ask`, because that time doesn't count against the hook's time limit. **Time spent awaiting a promise of your own does count.** Claude Code skips a hook that times out, so the held command would run.」
- mods/reference の Limits より。「A hook's own execution time for one event, not counting time inside `next` or a mods API call other than `$.clock.sleep`: 10 seconds」。
- `d.ts:5257-5294`（`HookBudget`）より。`ms: 10_000` は「from its call to its return」で数え、「the clock stops while a `next(e)` call or any `$` call of the hook's is in flight (a `$.clock` wait excepted)」。`catchMs: 1_000` と `lingerMs: 5_000` もここにある。
- `d.ts:3523-3536`（`$.clock.sleep`）より。「The wait is the hook's own time and its budget runs on through it, as through no other `$` call」。
- 時計が止まるのは、`next` か `$` の呼び出しが in flight の間だけである。module 内の Promise を await している間は止まらない。例えば `turn.complete` hook が resolve する `got[agentId]` を待つ間も、時計は進む。
- 予算を超えた hook は飛ばされる（`d.ts:4063-4065`）。Mod が登録した tool は、答える hook が無いと失敗する（`d.ts:3127`、「a call no hook answers fails」）。したがって、子の完了を module 内の Promise で 10 秒以上待つ `tool.call` hook は、その tool call ごと失敗する。
- **注意**: 型宣言の `$.agent.register` の例（`d.ts:3292-3300`）は、`tool.call` hook の中で `await answerOf(agentId)` を使って子の答えを待っている。`AgentSpawnResult` の例（`d.ts:416-420`）も、`turn.complete` hook で `got[agentId]` を resolve する形である。どちらも、子が 10 秒以内に終わらなければ上の規則で失敗する。この形を長い仕事の待ちに使ってはいけない。

### 2b. 予算を減らさずに長く待つ方法

原則は一次資料で確定している。待つ時間を `$` の呼び出し（`$.clock.sleep` を除く）か `next` の中に置く。mods/events と `d.ts:6950-6951` は「waits on `next` and `$` are free」と書き、`d.ts:6404` も「A `$` call's time never counts against the calling hook's budget」と書いている。

ここから先の組み立ては宣言からの推論である。設計書の構成では、次の形が合う。

1. **待ちを Supervisor の long poll にする。** `tool.call` hook は `$.http.fetch(url, { socketPath })` で Supervisor に「この Run が終わったら返す」と頼む。fetch は 1 回 30 秒まで（mods/reference の Limits、「One `$.http.fetch` call, redirects and body included: 30 seconds」）なので、超えた分は繰り返す。予算に数えられるのは、fetch と fetch の間の自分のコードだけになる。
2. **毎回 `next.signal.aborted` を確かめる。** `HttpInit` は `{ method, headers, body, auth, socketPath }` だけで、`signal` を受け取らない（`d.ts:3568-3569`）。dispatch が捨てられても、走っている fetch は止まらない。`lingerMs` は 5 秒なので（`d.ts:5286-5293`）、30 秒の fetch が残っていると hook は lingering と報告される。設計書 12.1 のとおり、1 回の待ちは短くする（提案値 1 秒）。そうすれば中断がすぐ効き、lingering も起きない。
3. **`$.process.run` は待ちに使わない。** 1 回で最大 10 分待てるが（`d.ts:3597-3598`）、one-shot であり、`signal` も無い。
4. **`$.clock.sleep` で poll しない。** sleep の時間は予算に数えられる。
5. **`turn.step` の generator も同じ規則に従う。** generator の予算は、自分のコードが動いている間だけ数える。`yield` や `next` の stream を待つ間は数えない（`d.ts:5273-5275`、`d.ts:12990-12993`）。`$` の呼び出しも数えない。Mod が worker の step を答える間に Codex を待つときも、1 と同じ long poll を使える。

設計書との関係は次のとおり。8.2 の「delegate は完了待ちしない」は、この制約と合っている。5.6 の `wait` の上限 30 秒は、`$.http.fetch` の 30 秒と同じ値になっている。ただし 2 で述べた中断への応答を考えると、1 回の HTTP は短くし、30 秒は短い poll の繰り返しで作るのがよい。

`tool.call` 全体の壁時計の上限（hook の予算とは別に、host が tool call をどこまで待つか）は、Mod が登録した tool については資料に無い（不明（実機が必要））。

---

## 3. `turn.step` で駆動する agent と `SubagentHandback`

### 渡される条件（一次資料で確定）

- tools-reference の `SubagentHandback` より。「Delivers a subagent's final report to whichever conversation receives that subagent's result. **Provided only in auto mode, to subagents that the Agent tool runs locally other than forks**, and available in the terminal CLI, IDE extensions, cloud sessions, and the Agent SDK; the classifier reviews the report before it's delivered. Requires Claude Code v2.1.271 or later.」
- 同じ page より。条件がそろえば、agent 定義の `tools` に無くても、`disallowedTools` に入っていても渡される。
- issue の前提「interactive の subagent が報告に使う」は正確ではない。決め手は auto mode であり、interactive かどうかではない。auto mode でなければ、どの subagent も `SubagentHandback` を持たない。

### Mod が spawn した worker に渡るか（宣言からの推論）

- `$.agent.spawn` は Agent tool を手元で background に起動する（`d.ts:3257-3258`）。fork でもない。したがって auto mode なら、Mod の worker も `SubagentHandback` を持つと読める。

### `turn.step` が作った tool call で配送できるか（不明（実機が必要））

- `turn.step` hook は `next` を呼ばずに chunk を yield して答えられる（`d.ts:4593-4595`）。yield した `tool` chunk は本物の tool call として記録され、実行される（`d.ts:14546-14552`）。名前が `SubagentHandback` の chunk を出すこと自体は、型の上では可能である。
- 配送された結果は、子の `turn.complete` の `answer` に入る（`d.ts:14196-14198`、「For a subagent's run that handed its report back to its spawner, the report delivered ... A refused hand-back changes nothing.」）。Agent tool の結果にも `handback: "send" | "flagged" | "withheld"` と `handbackReport` があるが、どちらも `@internal` である（`d.ts:17813-17821`）。
- 資料に無いことが 3 つある。
  - `SubagentHandback` の入力 schema。型宣言の `BuiltinToolInputs` にも tools-reference にも載っていない。
  - hook が作った tool call を、その agent の tool 一覧に照らして受け付けるか。
  - classifier の審査が、本物の model の推論を伴わない報告をどう扱うか。
- **G02 とぶつかる点**: classifier による審査は、それ自体が model の呼び出しである。`SubagentHandback` を使うと、「通常経路で余計なモデル要求がない」（G02）が成り立たない。

### 設計への提案（8.4、G08）

- 最上位の native delivery は、worker の最後の step で text を yield し `end_turn` で止めるだけで作れる。こうすると子の `turn.complete` の `answer`（`d.ts:14192-14200`）と Agent tool の結果に、その text が入る。auto mode に依存せず、classifier の呼び出しも生まない。
- `SubagentHandback` は主経路にしない。G08 の試験では、auto mode の有無の両方で、親が受け取る本文が 1 回だけ届くことを確かめる。auto mode で worker が `SubagentHandback` を呼ばずに text だけで終えたときに親へ何が届くかも、資料からは決まらない（不明（実機が必要））。

---

## 付記 A: spawn した hook は子のイベントを受け取らない

問いの範囲外だが、G05（子→孫）の前提を左右する。

### 書かれていること（一次資料で確定）

- `d.ts:14396-14398`（`TurnStepInput.agentId`）より。「A subagent a hook spawned through `$.agent.spawn` steps past that hook, as its tool calls do; every other hook sees its steps.」
- `d.ts:4586`（`turn.start`）と `d.ts:14317-14318`（`TurnStartInput.agentId`）より。「The hooks an agent's spawn was nested in do not hear its start, as at its `turn.step`s」。
- `d.ts:3102`、`d.ts:3016` より。`$` の呼び出しは「every hook but the calling one (the plugin's others see it)」を通る。
- mods/reference の `next.error` より。`kind: 're-entry'` は「when the hook was skipped because the event came from inside a mods API call by that hook or by your mod's code outside its hooks」。

### 設計書 7.3 への影響（宣言からの推論）

- worker A の `dispatch_control` を処理する `tool.call` hook（仮に H と呼ぶ）が `$.agent.spawn` で B を起こすとする。すると B の tool call は H を飛ばす。
- B が `dispatch_control` を呼んで孫 D を起こそうとしても、H は呼ばれない。答える hook が無いので、その tool call は失敗する（`d.ts:3127`）。
- 同じ plugin でも別の登録（`turn.step` の hook など）は、B の step を見る（「every other hook sees its steps」）。設計書 7.2 の「spawn が別の `turn.step` handler を飛ばさないか」という懸念は、別の登録にしておけば当たらない、と読める。

### 実機で確かめること（不明（実機が必要））

- 「nested in」の範囲。直接 spawn を呼んだ 1 つの hook だけか、その dispatch の frame の鎖全体か。孫の代でも同じかどうか。
- spawn を hook の外のコード（`$.clock.after` の callback など）から呼んだ場合。`re-entry` の説明（「by your mod's code outside its hooks」）からは、その Mod の hook がまとめて飛ばされる恐れがある。しかも、その場合の `parentAgentId` は委譲元の loop にならない見込みが高い（`d.ts:313-315` は「the loop the spawn happens in」）。
- 回避の候補。`dispatch_control` を処理する `tool.call` の登録を、深さの偶奇で分けて 2 つ持つ（同じ pattern を同じ matcher で 2 回登録すると throw するので、matcher を変える。`d.ts:6942-6948`）。または、spawn を行う hook と `dispatch_control` を受ける hook を別の登録にする。どちらも、G05 で子→孫→曾孫まで回して確かめる必要がある。
