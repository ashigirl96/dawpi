# Claude Code × Codex Bridge — 設計書 v2

**版:** 2.0  
**作成日:** 2026-10-24 JST  
**対象:** ローカルの Claude Code に、モデルを選択できる Codex エージェント群を統合する新規プラグイン  
**実装識別子:** `codex_bridge`（本書内の仮称。登録 tool 名などでは `<plugin>` と書く）  
**対象版:** Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）  
**検証状態:** 検証ゲートのうち G01〜G05、G08〜G10 を実機の prototype で判定した（19.1）。G06・G07、承認の UI、予算は紙の上の設計である。製品の実装はまだ無い。  
**前の版:** `docs/codex-bridge-design-v1.md`。v1 からの変更の根拠は、22 章の `[Kxx]` に並べた検証の ticket にある。

> **設計の要点**  
> Claude Code は対話と agent のホスト、Codex は推論と作業の実行基盤、Bridge は委譲の管理者とする。Bridge は Mod、Supervisor、Guard の三つから成る。Run ごとに Claude Code の agent（Worker）を一つ作り、Mod がその Host Step にモデルの代わりに答える。親子の Worker は、親の Worker が返す組み込みの `Agent` tool の呼び出しで作り、Claude Code 自身の親子関係をそのまま使う。タスク本文、実行設定、権限、実行履歴を独立させ、表示は実行履歴から作る。

### v1 からの主な変更

- Supervisor は Mod から `$.process.spawn` で起動し、Mod の寿命に従わせる。状態は memory だけに置き、SQLite・lease・復旧の手順を持たない。reload で Run は止まる（ADR `docs/adr/0001-supervisor-lives-with-the-mod.md`、[K07]）。
- 子の Worker は `$.agent.spawn` ではなく、親の Worker の Host Step が返す `Agent` の tool chunk で起こす。`$.agent.spawn` では親が付かない（[K02]、[K12]）。v1 の `dispatch_control` は無くなった。
- Claude 側の起動は 2 段にする。`delegate` が Run を用意して runId を返し、呼び出し元がその runId を prompt にして `Agent` を呼ぶ。Mod は `agent.spawn` hook で検問して bind する（[K11]、[K15]）。
- Worker は、子を待つ間は text で Worker の turn を終えて寝る（Yield）。Codex が Host Step を要する要求を出したら、Worker が寝る前に起動した Bell で起こす。`$.session.send` では起こさない（[K13]、[K14]）。
- Worker の Report は、manual mode では最後の Host Step の text、auto mode では `SubagentHandback` で出す。子と Bell の完了通知をすべて受け取ってから一度だけ出す（[K10]、[K13]、[K14]）。
- Mod が Worker の turn を握れない場面に備え、plugin の `hooks.json` に Guard を置く。Worker Roster に載った agent の、Permit の無い tool 呼び出しをすべて拒否する。ユーザーが置く allow rule は無くなった（[K15]、[K16]）。
- 最下層（Claude Code の main の下 3 層目）の Run には、子に関わる dynamic tool を広告しない（[K12]）。
- model と effort は毎回の `turn/start` で明示し、`observed` は Codex Turn を開始した時点の thread の設定で確かめる。app-server は値を検証しないので、Bridge が `model/list` で先に検証する（[K17]）。
- Codex 自身の委譲は、Bridge 専用の `CODEX_HOME`、起動引数、reviewer の固定、起動直後の確認と tripwire で止める（[K06]、[K08]、[K09]）。
- headless（`claude -p`）、Managed-only モード、Linux は初期版の範囲から外した。

## 1. 目的と完成条件

### 1.1 実現する体験

ユーザーは Claude Code で「認証の実装を Codex にレビューさせる」と依頼できる。親 Claude はタスク、モデル、推論強度、作業領域、権限を構造化して指定する。起動された Codex は、必要なら別の Codex に調査を委譲し、その子もさらに委譲できる。ユーザーは各エージェントの実行状況、コマンド出力、ファイル差分、質問を Claude Code 内で確認できる。

```text
Claude のメイン会話
└─ Codex：レビューの取りまとめ          （Claude Code の深さ 1）
   ├─ Codex：認証フローの調査            （深さ 2）
   │  └─ Codex：指摘事項の再現確認       （深さ 3。これ以上は委譲できない）
   └─ Codex：テストの確認                （深さ 2）
```

深さは Claude Code の数え方（main の下に何層目か）で、上限は 3 である。Claude Code 自身が深さ 3 の agent に `Agent` tool を渡さないため（[K02]、[K05]）。

モデル ID、推論強度、sandbox はプロンプト文法にしない。依頼欄には依頼だけを記述する。例えば `model: ...` で始まる文章であっても、タスク本文を設定として解釈しない。

### 1.2 要件

| ID | 要件 | 完成の判定 |
|---|---|---|
| R01 | Claude から Codex を起動できる | 型付き入力を受理し、実際の Codex の結果が返る |
| R02 | モデル・effort・作業領域を独立指定できる | 本文を解析せず設定され、Codex Turn を開始した時点の値を確認できる |
| R03 | Codex から Codex へ再帰委譲できる | 親→子→孫が同じ公開契約を使って実行される |
| R04 | ネイティブの親子関係を保持する | Claude Code が保持する親 ID が実際の委譲元と一致する |
| R05 | Tool の構造化表示がある | 入力、状態、出力、終了コード、差分を展開できる |
| R06 | 実行中・完了後に追加依頼できる | 実行中への追加入力と、完了後の会話再利用が区別される |
| R07 | 承認の対象と主体を特定できる | 普通のチャット発言を承認として扱わない |
| R08 | 親から子へ権限が増幅しない | 許可範囲を超える子の起動・設定変更を実行前に拒否する |
| R09 | 並列実行と停止を管理できる | 上限が守られ、親の停止が子孫へ伝わる |
| R10 | reload・切断で二重実行しない | 止まった Run を自動で再開・再送しない |
| R11 | UI と親モデルへの報告を分離する | 詳細ログが親モデルのコンテキストへ無条件に入らない |
| R12 | 互換性を確認して起動する | 対象バイナリと API 契約の試験結果を記録する |
| R13 | Mod が Worker の turn を握れないとき、その Worker に何もさせない | Mod の hook が外れた・Mod が消えた Worker の tool 呼び出しが拒否される |

R04 は単にツリー状に描くことではない。Claude Code 自身の親子関係を実機で確かめ、親 ID は Worker が返す `Agent` の呼び出しでだけ正しく付くと分かった（[K02]、[K12]）。R13 は v2 で足した要件で、Worker が `Agent` と Bash を持つことから生じる（[K14]、[K16]）。

### 1.3 初期リリースの範囲

macOS のローカル利用、単一ユーザー、ローカルの Codex CLI、interactive の Claude Code（manual mode と auto mode）を対象とする。コードは TypeScript、Supervisor は Bun 上で動作する。

Mod の reload、Claude Code の session の終了・再起動で、実行中の Run は止まる。止まった Run は再開しない（ADR 0001）。

次は初期範囲外とする。

- 他の人への配布（marketplace での公開など）。Bridge は作者の手元の Claude Code だけで使う。Supervisor は手元の Bun で動かし、Claude Code・codex-cli・Bun の版が変わったら、19.1 のゲートを流し直してから使う。
- headless（`claude -p`）からの利用。
- Linux。G06 にあたる process の停止の試験を通してから加える。
- Windows、クラウド常駐、複数ユーザー、任意の LLM provider への汎用化。
- Mod の reload や再起動をまたいで Run を続けること。

## 2. 公式 API と設計上の区別

本書の **「資料」** は公開資料と同梱の型宣言に書かれていることを、**「実機」** は対象版の prototype で観測したことを指す。**「採用仕様」** は本製品の設計判断、**「検証ゲート」** は対応版を公開するために必要な実機試験を指す。

一次資料は、Claude Code に同梱されている `plugin-authoring` skill とその型宣言 `claude-code.d.ts`（2.1.309）、Codex は `codex app-server generate-ts --experimental` の生成物とする。

| 論点 | 事実 | 本設計への意味 |
|---|---|---|
| Mods の実行環境 | 資料: Node / Bun が無い。`$.process.spawn` の stdin は一度渡すと閉じる [S01] | app-server と話すために Bun の Supervisor を置く [K04] |
| ツール登録 | 実機: engine は `inputSchema` を検証しない [K11] | 未知のプロパティの拒否などは Supervisor の contracts の検証器が行う |
| hook からの Agent 起動 | 実機: `tool.call` hook の `$.agent.spawn` は親が付かず（main の子扱い）、深さ上限も効かない。auto mode では classifier に拒否される [K02][K04][K11] | Worker の起動に使わない |
| `Agent` tool による起動 | 実機: Worker の `turn.step` が tool chunk で組み込みの `Agent` を呼ぶと、孫まで親が付き、深さ上限も効く [K02][K12] | 子の Worker はこの経路で起こす |
| ホストの上限 | 資料と実機: 深さは main の下 3 層、同時実行は 20。深さ 3 の agent には `Agent` tool が渡らない [S04][K02][K05] | 深さ 3 の Run には子に関わる tool を出さない |
| `turn.step` の失敗 | 実機: `.catch` が無い、または何も返さない hook は本物の model に落ちる [K02] | 全ての handler でエラー文を返して終える |
| hook の予算 | 資料: 10 秒の予算は module 内の Promise を待つ時間も数える。`next` と `$` の呼び出しは数えない [K05] | 長い待ちは Supervisor への `$.http.fetch` の long poll で行う |
| 再入 | 実機: Mod の `$.session.send` で起こした Worker の turn では、Mod 自身の hook がすべて外れる [K14] | Mod から Worker へ message を送らない |
| 報告 | 実機: manual mode は最後の text、auto mode は `SubagentHandback` だけが呼び出し元に届く。host は生きている background の子を持たない stop でしか届けない [K04][K10][K12][K13] | Report の条件と経路を 8.3・8.4 に定める |
| 権限 | 実機: auto mode では `Agent(...)` の allow rule がどの層でも捨てられる。Mod の `tool.check` の許可は auto mode では採られ、manual mode の Bash では飛ばされる。plugin の `hooks.json` の `allow` は両方の mode で採られる [K14][K15][K16] | 10 章の権限の段取り |
| UI | 資料: `ToolUse` / `ToolResult` / `AssistantMessage` / `Pane` の描画契約がある [S06] | 実機では確かめていない。6 章は紙の上の設計 |
| Codex 接続 | 実機: app-server の Unix socket は WebSocket しか話さない。stdio なら Bun から往復できる [K04] | Supervisor が app-server を stdio で持つ |
| dynamic tool | 資料: 実験的機能 [S07]。実機: 応答を 15 分保留しても Codex Turn は続く。保留中も model が code mode の `wait` で約 30 秒ごとに起きる [K03] | `bridge_delegate`・`bridge_wait` は応答を保留する形にする |
| 実行設定 | 実機: `turn/start` の model・effort は以後の Codex Turn に残る。app-server は model も effort も検証しない [K17] | 毎回明示し、Bridge が先に検証する |
| Codex 自身の委譲 | 資料と実機: `agents.enabled=false` などで止まる。reviewer は起動引数では止まらない [K06][K09] | 8.5 の条件で止める |
| 実行項目 | 資料: command / file change / MCP / dynamic tool は別の構造化型 [S09] | 最初から項目別のデータと描画を設ける |

本書の `delegate`、`configure`、`RunSpec`、Worker、Bell、Guard、Permit 等は**新しく実装する本製品の契約**であり、Claude Code / Codex の組み込み API 名ではない。用語は `GLOSSARY.md` に従う。Codex の一回の応答は **Codex Turn**、Claude Code がモデル応答を求める一回は **Host Step** と呼ぶ。Claude Code の agent が Host Step を重ねて止まるまでの並びは「agent の turn」（Worker なら「Worker の turn」）と書き、「turn」を単独では使わない。

## 3. 基本構成

### 3.1 三つの責任を分ける

```text
┌──────────────────────────────────────────────────────────┐
│ Claude Code（1 session）                                  │
│  main Claude / Claude の subagent / 対話 UI               │
│                                                          │
│  Bridge Mod（module hooks）                               │
│   ・登録 tool（delegate ほか）  ・Worker 型の登録         │
│   ・Worker の Host Step に答える ・agent.spawn の検問     │
│   ・Pane の UI                                            │
│                                                          │
│  Worker（Run ごとの agent）  Guard（plugin の hooks.json）│
└──────────────┬───────────────────────────────────────────┘
               │ HTTP over Unix socket（command / events の long poll）
┌──────────────▼───────────────────────────────────────────┐
│ Supervisor（Bun。Mod が $.process.spawn で起動）           │
│  ・Run の状態機械（memory）  ・保留中の dynamic tool 呼び出し│
│  ・Worker の次の Host Step の決定  ・Permit の発行          │
│  ・Bell の FIFO  ・Worker Roster への書き込み               │
│               │ stdio の JSON-RPC                          │
│               ├─ codex app-server：Run A                   │
│               ├─ codex app-server：Run B                   │
│               └─ codex app-server：Run C                   │
└──────────────────────────────────────────────────────────┘
  Bridge の state の directory（~/.codex-bridge/）
   codex-home/ ・sessions/<sessionId>/{roster, permits, bells}
```

**Mod はホスト接続と画面、Supervisor は実行管理、Guard は Mod が居ない場面の守り、Codex は実作業を所有する。**

Supervisor は 1 つの Claude Code session に 1 つで、Mod の寿命に従う。Mod は Run の正本を持たず、hook を Supervisor への command と long poll に翻訳し、UI を描く。Guard は Mod とも Supervisor とも別に、Claude Code が plugin の hook として起動する短い command である。

### 3.2 この構成を採用する理由

Mod は app-server と直接話せない。Mod の実行環境には Node も Bun も無く、`$.process.spawn` の stdin は一度しか書けず、app-server の Unix socket は WebSocket しか話さない（[K04]）。そのため、どの形でも Bun の process が要る。Run の状態機械をその process（Supervisor）に置くと、Supervisor は Claude Code が無くても `bun test` で試せる（[K07]）。

Supervisor を Mod の寿命に従わせるのは、初期版が reload で Run が止まることを許容しているからである。切り離した Supervisor が要求する lease、heartbeat、孤児の掃除、所有 epoch、再起動をまたぐ永続化を持たずに済む（ADR 0001）。

子の Worker の生成はホストの責任なので、Supervisor や Mod から親 ID を偽装して作ろうとはしない。親の Worker が返す `Agent` の tool chunk を Claude Code に実行させ、ホスト自身が親子関係を付ける（[K02]）。

Guard を Mod から分けるのは、Mod の hook が外れた Worker の turn や、Mod の module が消えた後にも働く必要があるからである。Mod の module hook は自分の再入で外れ、`AgentSpec.hooks` は Worker の型が消えると外れる。plugin の `hooks.json` の hook はどちらの場面でも残る（[K16]）。

プロセス境界はライフサイクルと障害処理のためであり、それ自体をセキュリティ sandbox とは呼ばない。

**将来の移行先。** reload をまたいで Run を続けたくなったら、Supervisor を `$.process.run` の bootstrap で切り離す（v1 の 3.1、12.1、15.3 の形）。Mod との通信は既に HTTP over Unix socket の long poll なので、替わるのは起動方法と、lease と永続化の追加である。app-server を `--listen unix://` で切り離せば、Supervisor が作り直されても `thread/resume` で保留中の `item/tool/call` が同じ `callId` で送り直される（[K03]）。`$.process.run` で起動した process が ppid 1 で残ることは実機で確かめた（[K04]）。session の終了をまたいで残ることは型宣言に書かれているが、実機では確かめていない（[K07]）。

### 3.3 状態の正本

| 情報 | 正本 |
|---|---|
| 論理的な親子関係・Run の状態・予算・操作の受理・保留中の dynamic tool 呼び出し | Supervisor の memory |
| Codex 内の会話と実行結果 | Codex の thread / Codex Turn / item（Bridge 専用の `CODEX_HOME` に残る） |
| Claude Code の Agent ID と実際の親 ID | Claude Code |
| Worker Roster と Permit | Bridge の state の directory の file |
| Pane に見せる snapshot | Mod の `$.state`（正本ではない。Supervisor の events から作る） |
| 現在表示しているタブ・折り畳み | Mod の UI 状態 |
| 呼び出し可能なモデル | Bridge 専用の `CODEX_HOME` の認証に対する Codex のモデル一覧 |
| 実行能力の上限 | 管理ポリシー、ユーザーの grant、Codex/OS の制約 |

Worker Roster と Permit は、ADR 0001 の「状態は Supervisor の memory だけ」の例外である。Mod や Supervisor が止まった後も Guard が Worker を見分けられることが、Guard が fail closed で働く条件になる（[K16]）。

表示上のラベル、プロンプト内の文字列、モデルの自己申告を正本にしない。対応関係の不整合はログで隠さず、その Run を `failed` にして理由を残す。

## 4. データモデル

### 4.1 会話と仕事を分ける

**Conversation** は再利用可能な Codex の会話。**Run** は一回の委譲された仕事。**Codex Turn** はその仕事中の一回の Codex の応答である。

一つの Run は複数の Codex Turn を含みうる。例えば追加指示や、子の結果を受けた最終統合が該当する。ただし、完了済み Run を再び実行中に戻さない。完了後の追加依頼は新しい Run を作り、許可された場合に同じ Conversation を再利用する。Conversation の再利用は Supervisor の寿命の中に限る（ADR 0001）。

Run ごとに Worker を一つ作る。Worker は Claude Code の agent で、Run と一対一に bind する。

```ts
// 本製品で新しく定義する概念型。公式 SDK の型ではない。
type Run = {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;                 // Worker の Claude Code での深さ。main の直下 = 1
  caller: {
    kind: "claude" | "codex" | "user";
    agentId: string | null;      // delegate を呼んだ agent。main は null
  };
  conversationId: string;
  predecessorRunId?: string;     // 完了後の追加依頼でのみ設定
  workerAgentId?: string;        // bind で確定する
  specRevision: number;
  status: RunStatus;
  preparedDeadline: string;      // prepared のまま過ぎたら expired
  resultId?: string;
};

type RunStatus =
  | "prepared" | "starting" | "running"
  | "waiting_children" | "waiting_user" | "finalizing"
  | "cancelling" | "completed" | "failed" | "cancelled" | "expired";

// Worker の側の状態。Run の終端と Report の配送は別の事実として持つ。
type WorkerState = {
  agentId: string;
  runId: string;
  awake: boolean;                // false の間は Yield している
  bell: "none" | "armed" | "rung";
  pendingNotices: string[];      // 会話にまだ入っていない子・Bell の完了通知
  pendingControl?: ControlOp;    // 次の Host Step で返す操作（子の Agent など）
  reported: boolean;
};
```

| status | 意味 |
|---|---|
| `prepared` | 権限の判定を通った `delegate` が Run を作った。Worker はまだ無い。期限を過ぎたら `expired` |
| `starting` | `agent.spawn` で Worker を bind した。app-server の起動と `thread/start` の途中 |
| `running` | Codex Turn が動いている |
| `waiting_children` | Codex が `bridge_wait` を保留している、または子が生きたまま Codex Turn が終わった |
| `waiting_user` | Codex の承認要求をユーザーに出している |
| `finalizing` | 子の結果を受けた統合の Codex Turn |
| `cancelling` | 停止を受けて、Codex Turn と子孫の終端を待っている |
| `completed` / `failed` / `cancelled` / `expired` | 終端。結果は不変 |

`parentRunId`、`rootRunId`、`depth`、`caller` はモデル入力に含めず、Claude Code の tool event の agentId と、Codex の threadId から計算する。同じ Conversation に二つの非終端 Run を同時接続しない。

Worker は子の終了や Bell の完了で resume されるたびに、新しい Worker の turn の Host Step 0 から起こされる（[K02]）。そのため Worker の Host Step は、Host Step の位置ではなく `WorkerState` と Run の状態で決める。

### 4.2 ID と対応付け

| ID | 発行主体 | 用途 |
|---|---|---|
| `runId` | Supervisor | 委譲された仕事の識別。`Agent` の prompt に入れる相関 ID で、認証ではない |
| `requestKey` | 入力 adapter | 冪等な操作の識別。Claude からは `tool_use_id`、Codex からは `callId` |
| `messageId` | 入力 adapter | 一回のメッセージ配送 |
| `agentId` | Claude Code | Worker のホスト側の識別。bind で Run に結ぶ |
| `tool_use_id` | Claude Code / Supervisor | tool 呼び出しの識別。Mod が返す tool chunk の id は Supervisor が決め、Permit の名前にする |
| `threadId` / `turnId` / `itemId` / `callId` | Codex | provider 側の実行識別 |
| `approvalId` | Supervisor | 許可要求を特定 |
| `resultId` | Supervisor | 不変の結果と配送重複の識別 |

同じ文字列を二度入力した場合は、二つの `messageId` である。本文の一致を理由に重複削除しない。JSON-RPC の request id、Codex の `callId`、`itemId` は別のものとして扱う。request id は接続ごとに振り直される（[K03]）。

## 5. 公開 API とモデル設定

### 5.1 一つの契約を複数の入口で使う

Claude からは Mod の登録ツール、Codex からは dynamic tool、人間からは設定パネルを使う。三つの入口は同じ検証器・同じ Supervisor の操作に到達する。

| 論理操作 | Claude 側の登録ツール | Codex 側の dynamic tool |
|---|---|---|
| 子の委譲 | `mcp__<plugin>__delegate` | `bridge_delegate` |
| 状態取得 | `mcp__<plugin>__inspect` | `bridge_inspect` |
| 結果を待つ | `mcp__<plugin>__wait` | `bridge_wait` |
| 追加指示 | `mcp__<plugin>__send` | `bridge_send` |
| 設定変更 | `mcp__<plugin>__configure` | `bridge_configure` |
| 停止 | `mcp__<plugin>__cancel` | `bridge_cancel` |

通常のモデルに承認権限を渡す `approve` ツールは登録しない。ユーザー本人の承認は別の UI 操作として扱う。

ツールは所属する Run の直下の子を操作できる。兄弟、祖先、別ツリーの Run を操作する権限は既定では与えない。ユーザーの管理 UI は本人に許可されたツリー全体を扱える。

**入口ごとの起動の形。** 子の委譲は、どの入口でも「Run を `prepared` で用意する」と「呼び出し元の loop が `Agent` で Worker を起こし、Mod が bind する」の 2 段になる（7.2）。

- Claude（main または Claude の subagent）の `delegate` は、Mod の `tool.call` hook が先に `next(e)` を呼んで host の権限の判定に回す。auto mode では classifier が task を審査し、manual mode ではユーザーの承認か allow rule で決まる。拒否されたら Run を作らない。通ったら Run を用意して runId を返し、「`Agent`（`subagent_type: <plugin>:worker`、prompt は runId）を呼ぶ」ことを結果の文面で伝える（[K11]、[K15]）。
- Codex の `bridge_delegate` は、Supervisor が Run を用意して `item/tool/call` への応答を保留する。親の Worker の Host Step が `Agent` を返し、bind した直後に応答する（7.3）。
- 人間の UI からの起動は、初期版では main の会話に `delegate` を呼ばせる形にとどめる。Worker の親になる agent が要るため。

**最下層の Run。** Claude Code が `Agent` を渡さない深さ 3 の Run では、`thread/start` の `dynamicTools` から子に関わる tool（上の表の Codex 側の六つ）をすべて外す。Codex は委譲できないことを最初から知り、失敗する試行と余計な Codex の request が起きない（[K12]、[K13]）。

**導入手順。** ユーザーが置かなければならない allow rule は無い（[K15]、[K16]）。

- Bridge 専用の `CODEX_HOME` で一度 login する（`CODEX_HOME=~/.codex-bridge/codex-home codex login`。10.6）。
- plugin を有効にする。Guard は plugin の hook なので、plugin が無効なら Bridge は起動しない（10.4）。
- manual mode では、`delegate` のたびに承認を求められる。承認は task を見て決める場面なので、既定ではそのままにする。`mcp__<plugin>__delegate` の allow rule は任意として案内する。
- `Agent(<plugin>:worker)` の allow rule と `autoMode.allow` の文章の rule は書かない。前者は auto mode でどの層に置いても捨てられ、後者は Mod が許可するので要らない（[K15]）。

### 5.2 起動入力

以下は本製品に実装する入力の例である。モデル ID は例示であり、実際に利用できるかは `model/list` で検証する。

```json
{
  "task": {
    "title": "認証実装のレビュー",
    "prompt": "Review the authentication implementation."
  },
  "execution": {
    "model": "gpt-6-astra",
    "effort": "high"
  },
  "workspace": {
    "directory": "/path/to/project",
    "isolation": "shared-read"
  },
  "permissions": {
    "sandbox": "read-only",
    "approvalPolicy": "on-request"
  },
  "context": {
    "artifacts": []
  }
}
```

書き込みを依頼する場合は、権限の範囲内で `workspace-write` と隔離した作業領域を選択する。`workspace.isolation` は本製品の作業領域管理であり、Codex の sandbox の別名ではない。

モデル公開 schema では未知のプロパティを拒否する。engine は登録 tool の `inputSchema` を検証しない（`additionalProperties: false` に反する値が、型も違うまま `tool.call` に届いた）ので、検証は Bridge の検証器が行う（[K11]）。Claude からの入力も Supervisor が検証する。hooks module は plugin の folder の中の file と `claude-code` しか import できず、`packages/contracts` を読めないため（#23 で `claude plugin validate` が拒否した）。Mod は登録に使う JSON Schema の写しだけを持ち、root の試験が contracts と一致することを確かめる。任意の環境変数、任意の CLI フラグ、認証ファイルの場所、任意の `config` オブジェクト、`approvalsReviewer` はモデルから受け付けない。

モデルは、ユーザーが指定していない緩い権限を自分で入力に足すことがある（main の Claude が `approvalPolicy: "never"` を足した観測がある。[K11]）。既定より緩い値は、ユーザーの grant が無ければ拒否する（10.2）。

### 5.3 モデル一覧と effort

Codex の `model/list` をページ末尾まで取得し、Bridge 専用の `CODEX_HOME` の認証ごとにキャッシュする。UI のモデル選択後に、そのモデルに対応する effort の選択肢を表示する。モデルの能力一覧をコードへ固定しない。[S07]

**検証は Bridge の責任である。** app-server は model も effort も検証しない。未知の model も、catalog に無い effort も、Codex の知らない effort も、`thread/start`・`turn/start` で受け付けて thread の設定に保存し、provider の 400 で Codex Turn を失敗させる。その値は次の Codex Turn にも残る（[K17]）。Bridge は `delegate`・`configure` の時点で catalog に照らして拒否する。

catalog を正とする。provider が受け付ける effort（`none`〜`max`）と catalog の一覧は一致しないので、provider が受け付けても catalog に無い値は拒否する。effort の既定値は model ごとに catalog から取る（[K17]）。`ultra` は catalog にあっても拒否する。委譲を止めた構成でも provider には `max` として送られ、費用の見積もりが狂うため（[K06]、[K09]）。

カタログを取得できない場合はキャッシュの更新日時を表示する。モデルの削除、権限不足、対応しない effort は、別の値への黙った置換ではなく検証エラーにする。

### 5.4 設定の解決

通常の値の優先順は、**呼び出し時の指定 → 選択した profile → 起動時点の親の有効設定 → ユーザーの既定値 → catalog の既定値**とする。

この優先順は権限の上書き順ではない。どの指定であっても、管理ポリシーと委譲の上限を超えられない。指定値が上限に反する場合は拒否し、理由と許可された範囲を返す。黙って設定を縮小して「要求どおり実行した」とは見せない。

保存する設定は次の三種類とする。

| 種類 | 意味 |
|---|---|
| `requested` | 入力が明示した値 |
| `resolved` | 既定値を補い、制約検証を通した値。effort に null を入れない |
| `observed` | Codex Turn を開始した時点で、thread の設定として受理された値 |

**`observed` の出どころ（[K17]）。** Codex Turn ごとの model と effort を返す app-server の API は無い（`Turn` にその欄が無い）。thread の設定は Codex Turn の開始時に取り込まれる。そこで Bridge は毎回の `turn/start` で `resolved` の model と effort を明示し、その Codex Turn の開始時に届いた `thread/settings/updated` の値を `observed` にする。届かなければ前の Codex Turn の値のままである（値が変わっていない）。`model/rerouted` が来たら、その Codex Turn の model を `toModel` で上書きする。

`observed` は Codex Turn の開始で確定し、後から `thread/read` で読み直さない。実行中に thread の設定が変わると、`thread/read` はその Codex Turn とずれた値を返すため（[K17]）。rollout の `turn_context` は app-server の API ではなく版で形が変わりうるので、`observed` には使わず診断にだけ使う。

**見えないもの。** provider が実際に使った model（`model/rerouted` の通知を除く）と、provider 向けの effort の読み替え（`ultra` が `max` になるなど）は Bridge から見えない（[K09]、[K17]）。UI はこれらを unknown と表示し、要求した値を実績へコピーしない。

子には親の設定の**起動時点のスナップショット**を渡し、後の親の変更を勝手に伝播させない。

### 5.5 実行中の設定変更

`configure` は `expectedRevision` と patch を受け、競合した編集を検出する。model / effort の変更は Bridge が予約として持ち、次の `turn/start` で model と effort を明示して渡す（`apply: "next-turn"`）。`thread/settings/update` と `turn/settings/update` は使わない。前者は効果が同じで `thread/read` とのずれを生み、後者は既定で無効な feature（`step_model_switching`）を要求して拒否されるため（[K17]）。実行中の Codex Turn の model を変える `active-turn` の設定変更は、初期版では提供しない。`turn/steer` は追加入力であり設定変更の経路ではない。[S07][S08]

```json
{
  "runId": "run_example",
  "expectedRevision": 3,
  "patch": {
    "execution": { "model": "gpt-6-astra", "effort": "high" }
  },
  "apply": "next-turn"
}
```

sandbox の拡大、書き込み先の追加、ネットワーク権限の増加は一般設定と分離する。進行中の Codex Turn へ混ぜず、ユーザーの grant を更新し、必要なら停止・再設定する。`cwd` と作業領域の入れ替えは同一 Run 中に許さず、新しい Run とする。

### 5.6 操作ごとの返答と期限

| 操作 | 必須となる主な入力 | 返答・効果 |
|---|---|---|
| `delegate`（Claude） | task、必要な設定 | 権限の判定を通れば `runId` と `prepared`、次に呼ぶ `Agent` の案内。拒否なら Run を作らずエラー。`accepted` は 2 段目の `Agent` で bind が済んだ時点を指し、`inspect` と UI で見える |
| `bridge_delegate`（Codex） | task、必要な設定 | 子の Worker を bind した時点で `runId` と `accepted`。bind できなければ失敗 |
| `inspect` | runId | 状態、設定 revision、子の一覧、結果の参照。読み取りのみ |
| `wait` | runIds、all または any、timeout | 終端した子の結果と pending の一覧。再実行しない |
| `send` | runId、text、配送方針 | messageId と queued / accepted。応答文の生成完了は待たない |
| `configure` | runId、expectedRevision、patch | 新しい revision と適用時点、または conflict |
| `cancel` | runId、reason | 停止操作の receipt。停止確認前は cancelling |

**`wait` の答え方。** Codex の `bridge_wait` は `item/tool/call` への応答を保留する。Supervisor は、子の Run が終端にあり、かつ子の Worker の turn の終わり（`turn.complete`）が来た後に答える。子の Report の時点では子の Worker の turn がまだ終わっておらず、親の Worker はその後の完了通知で起こされるため（[K13]）。期限が来たら Supervisor が Host Step を使わずに `pending` で答える（[K14]）。期限後に返る pending は、子を再起動する理由にしない。

結果の文面は Codex がそのまま読める text にする。field を取り出させる指示は出さない。code mode の model が文字列を object と取り違えた観測がある（[K13]）。

Claude 側の `wait` の一回の上限は 30 秒とする。最上位の Run の結果本文は Report で届くので、Claude 側の `wait` は状態と receipt を返す（8.4）。

**配送方針。** `send` は `next-turn` を既定とし、明示した `active-turn` の場合だけ進行中の Codex Turn への `turn/steer` を試みる。`turn/steer` は dynamic tool の応答を保留している間も受理され、応答後の最終 message に反映された（[K03]）。既に Codex Turn が終わっていた場合、provider が明示的に未受理を返せば次の Codex Turn へ queue できる。通信失敗で受理状況が不明な場合は自動的に別の Codex Turn へ送らない。

内部 transport の再試行キーは adapter が入力の同一性から作る。モデルが任意の caller や偽の接続識別子を指定するフィールドは存在しない。

## 6. UI と操作体系

本章は紙の上の設計である（G07）。描画の API を実機では確かめていない。

### 6.1 主画面

Claude Code のネイティブ Agent 一覧を保ち、Bridge の詳細画面には次を配置する。

| 領域 | 内容 |
|---|---|
| Run ツリー | 親・子・孫、状態、モデル、未解決の承認数 |
| 設定バー | 実行中の設定と次の Codex Turn の予約設定、cwd、制限 |
| タイムライン | 発言、コマンド、差分、委譲、質問、失敗 |
| 詳細欄 | 選択項目の元入力と出力、差分、実行時間 |
| 入力欄 | 通常の追加指示。設定や承認を本文として解釈しない |

`/codex` は本製品が新規登録するパネルの入口とする。起動、モデル選択、実行中の Run への切り替え、承認一覧、診断へ移れる。既存の `/model` の意味を全セッションで書き換えない。

### 6.2 表示する Tool 項目

| 種類 | 折り畳み時 | 展開時 |
|---|---|---|
| Command | 実行概要、状態、経過時間、終了コード | 元コマンド、cwd、取得できた出力 |
| File change | ファイル名、追加・変更・削除、状態 | provider が返した差分 |
| MCP | server / tool、状態 | 引数、結果、エラー |
| Delegate | 子のタスク、モデル、状態 | 子 Run への移動、設定、結果 |
| Wait | 対象の子と残数 | 各子の状態とタイムアウト |
| Approval | 対象操作と要求権限 | 元要求、期限、許可範囲、承認操作 |
| Usage | 自身の消費、子孫を含む消費 | 入力、キャッシュ、出力、計測範囲、`bridge_wait` の保留中の消費 |

Codex の出力が stdout と stderr を集約している場合、UI も「出力」として表示する。分離されていない情報を別ストリームとして捏造しない。`cat` や `rg` らしいコマンドであっても、元の実行を Claude の `Read` / `Grep` として偽装しない。[S09]

### 6.3 描画の接続

詳細表示は、Mod が開く `Pane` のタイムラインとする。Worker の表示には要約と詳細への導線を用意する。

Mod は Supervisor の events を long poll する loop を一つ持ち、Pane に見せる snapshot を `$.state` に書く。`$.state` は描画中に読むと購読になり、書き込みで再描画される。`$.state` は session ごとで hot reload の後も残るが、正本ではない（[K07]）。

**独自 Tool カードを描くことと、Claude Code 内部の ToolUse 記録を作ることは別である。** Codex が既に実行したコマンドを、Claude の実行用 `Bash` tool call として送り返さない。Worker が返す tool chunk は、これから実行する Bridge の段取り（子の `Agent`、Bell、登録 tool、Report）だけである。[S05][S06]

### 6.4 実行と表示を分離する不変条件

`render(state)` は、外部プロセス起動、RPC 送信、権限変更を行わない。UI のボタンは描画と別の action handler を呼び、対象の revision と操作主体を伴って Supervisor へ送る。

画面を開き直す、履歴を再生する、端末サイズを変更する、出力を展開する、といった操作によって仕事が再実行されてはならない。

## 7. Claude Code とのネイティブ統合

### 7.1 Worker 型を一種類だけ登録する

Mod は `<plugin>:worker` を Worker の agent 型として `$.agent.register` で一つだけ登録する。モデルごと・権限ごとに型を増殖させない。Worker の型は Claude Code の agent 一覧に出る。`agent.offer` は一覧と dispatch を区別できないので隠さず、説明文に「`delegate` の 2 段目でだけ使う」と書く。実際に起動を止めるのは `agent.spawn` hook の deny である（[K11]）。

Worker の定義は次のとおりにする。

- `tools` は `Agent`、Bash、Bridge の登録 tool。Bash は Bell のためだけに持つ。登録 tool は、Report の前に Worker の turn を止めずに Host Step を一つ進めるために使う（8.3）。`Agent` だけにすると、深さ 3 で `Agent` が外れて tool が空になり、起動そのものが拒まれる（[K12]）。`SubagentHandback` は auto mode で engine が足すので書かない（[K10]）。
- `hooks` は書かない。`AgentSpec.hooks` は Mod の呼び出しと model の呼び出しを見分けられず、Worker の型が消えると外れる（[K16]）。守りは Guard が担う（10.4）。
- `prompt` は「何もしない」とする。ただし守りには数えない。型が消えても prompt は残るが、従うかは model 次第である（[K16]）。
- `maxTurns` は使わない。Mod が駆動した Host Step も数え、Mod の段取りを切る（[K16]）。
- Codex のモデル名を Claude のモデル resolver に渡さない。ホスト上の登録用モデルと、実際の Codex モデルは別フィールドに保持する。

**Host Step の駆動。** Worker の `turn.step` は Mod が処理し、中間の Claude 推論を必要としない。どの prototype でも Worker の Host Step はすべて `usage: null` で、余計な model の要求は無かった（G02）。Mod は Host Step ごとに Supervisor へ「この Worker の次の Host Step で何を返すか」を尋ね、Supervisor は Run と `WorkerState` から決める。

- 未配送の制御操作（子の `Agent`）があれば、その tool chunk を返す。
- Codex Turn が動いていれば、Run ごとの cursor から Supervisor の events を long poll で読み、Host Step を開いたまま待つ。待ちは hook の予算をほぼ消費しない（[K04]）。
- 子を待つことになったら、Bell を起動してから text で Worker の turn を終える（Yield。8.2）。
- Report の条件がそろったら、Report を一度だけ返す（8.3）。

**hook の失敗。** `.catch` が無い、または何も返さない `turn.step` は本物の model に落ちる（[K02]）。全ての handler は例外をエラー文の text に変換して Worker の turn を終える。意図的なモデル fallback は行わない。

**Mod が Worker の turn を握れない場面。** 次の場面では Worker の turn が model として動く。

- Mod 自身の呼び出しの中で起きた Worker の turn（再入）。Mod の `$.session.send` や `SendMessage` の `$.tool.call` で Worker を起こすと、Mod の hook がすべて外れる（[K14]）。Mod から Worker へ message を送らない。
- Mod の module が消えた後に、子や Bell の完了通知で起こされた Worker。型も消えていれば、Worker は `general-purpose` として hook なし・全 tool で resume される。system prompt と `agent_id` は残る（[K16]）。
- `agent.spawn` の中で bind より前に `await` し、Mod の `turn.step` がまだ Worker を知らない Host Step 0（[K16]）。Mod の `turn.step` が `next` を呼ぶと model に流れる。

最初の二つの場面では、Guard が Permit の無い呼び出しをすべて拒否する（10.4）。三つ目の場面は Worker Roster を書く前に起きうるので、Guard ではなく次の二つで塞ぐ。

- Mod は `agent.spawn` で `next(e)` が返した `agentId` と runId の対応を、`await` より前に module 変数へ同期的に記録する。Supervisor への bind の command と Worker Roster の書き込みは、その後に行う。
- Worker 型の agent の `turn.step` は、決して `next` に流さない。bind がまだ済んでいなければ、bind を待ってから答える。

### 7.2 起動は prepare → bind → activate

1. 呼び出し元が委譲を求める。Claude の `delegate` は `next(e)` で host の権限の判定を通す。Codex の `bridge_delegate` は `item/tool/call` として Supervisor に届く。
2. Supervisor が contracts の検証器で入力の schema を検証する。Claude からの入力は Mod がそのまま渡し、Codex からの入力は Supervisor が受ける（5.2）。続けて Supervisor が権限・深さ・予算・重複を確認する。深さは、Claude の caller なら Mod が `$.agent.list()` の `parentId` を辿って数え、Supervisor に渡す。
3. Supervisor が `runId` を発行し、caller の agentId、深さ、期限と一緒に Run を `prepared` で作る。
4. 呼び出し元の loop が `Agent`（`subagent_type: <plugin>:worker`、prompt は runId）を呼ぶ。main と Claude の subagent では model が呼び、Codex の親では親の Worker の Host Step が tool chunk で返す（7.3）。
5. auto mode の main・Claude の subagent の `Agent` は、Mod の `tool.check` が許可する。条件は、`subagent_type` が Worker、prompt が `prepared` な runId、その runId を用意した caller と同じ agent からの呼び出し、の三つ（[K15]）。親の Worker の `Agent` は Guard が Permit で通す（10.4）。
6. Mod の `agent.spawn` hook が、同じ三つの条件と `parentAgentId` を Supervisor に照合させる（`run.claim`）。外れたら deny する。deny は呼び出し元に tool error として届く（[K11]）。合えば Supervisor が Run を CAS で `prepared` → `starting` にしてから、Mod が `next(e)` を呼ぶ。返った `agentId` と runId の対応を `await` より前に module 変数へ記録し（7.1）、続けて bind の command（`run.bind`）を送る。Supervisor は Run に `workerAgentId` を書き、Worker Roster に `agentId` を書く。Mod の hook はその応答を待ってから返る。CAS を `next(e)` の前に置くので、bind の応答を確かめられなくても Run は `starting` のまま残り、同じ runId の二つ目の Worker は起動しない（T11）。host が Worker を起動しなかったとき（`next` が deny、または `agentId` が無い）は、Run を `failed` にする（`run.abandon`）。
7. Worker の Host Step 0 で activate する。Supervisor が app-server を起動し、`thread/start` と最初の `turn/start` を送る。
8. Codex の親には、bind の直後に保留中の `bridge_delegate` へ `accepted` を返す。Claude の呼び出し元には、`delegate` の時点で runId を返してある。

`agent.spawn` の `next` は、観測では Worker の Host Step 0 より 12〜15 ms 先に解決した（[K11]）。順序は型で保証されていないので、bind より先に Host Step 0 が来た場合は、Worker の会話の prompt から runId を引いて bind する。

**bind の前の終わり。** 子の Worker が bind より先に終わる順序がある。tool が空の Worker は起動を拒まれ、その `turn.complete`（`reason: "error"`）が `next` の解決より先に届いた（[K12]）。bind の前の終了も Run の終端（`failed`）として扱い、`accepted` を返さない。

**prepared のまま残る Run。** `Agent` まで進まなかった Run は、期限を過ぎたら `expired` にする。main の model が `Agent` を呼ばずに終えた場合や、`Agent` が拒否された場合がこれにあたる。2 段目の `Agent` を classifier に任せていた prototype では、拒否が 3 回起きた（[K12]、[K13]）。v2 では 2 段目を Mod の `tool.check` が許可するので、classifier による拒否は起きない想定である（[K15]）。期限（`preparedTtl`）は 5 分とする。manual mode の main がユーザーに確かめてから `Agent` を呼ぶ場合も収まる長さにした。Supervisor は 1 秒ごとと、Run を引くたびに期限を確かめ、`run.expired` の event を出す。#23 の実機で、Agent まで進まなかった Run が期限の 1 秒後に `expired` になった。

runId は相関 ID であって認証ではない。守りは、`prepared` であることの CAS と、caller の一致で行う。

### 7.3 Codex からの子起動を、正しい親ループへ戻す

```text
Codex A
  │ bridge_delegate(spec)            … item/tool/call の応答を保留する
  ▼
Supervisor
  │ threadId から Run A を特定し、Run B を prepared で作る
  │ A の Worker の次の Host Step に Agent を予約する
  │ A の Worker が Yield していれば Bell を鳴らす
  ▼
A の Worker の Host Step（Mod が答える）
  │ Supervisor が tool_use_id を決めて Permit を書く
  │ Agent(subagent_type: worker, prompt: runId B) の tool chunk を返す
  ▼
Guard … Permit を確かめて allow
  ▼
Claude Code が Agent tool を実行
  │ Mod の agent.spawn: caller が A の Worker であることを確かめ、bind
  ▼
Native Agent B ↔ Run B ↔ Codex B
  ▼
Supervisor が A の保留中の bridge_delegate に accepted（runId B）を返す
```

`item/tool/call` を受けてから応答まで 11〜51 ms、`Agent` の dispatch から bind まで 12〜35 ms だった。応答の後、Codex A の Codex Turn は完了まで続いた（[K12]）。

bind が拒否されたときも、host が `Agent` を通さなかったときも、Codex に失敗を返す。host が深さ上限で `Agent` を渡さないと `No such tool available: Agent` の tool error になり、`agent.spawn` は起きない。Supervisor は、次の Host Step で子の Run が `prepared` のままであることから失敗を知る（[K12]）。Bridge は最下層で委譲の tool を出さないので、通常経路でこれには当たらない。

ここで返す tool call は、**未実行の子起動要求を実行するもの**である。既に Codex が終えた shell 操作の再現ではない。ホスト側の一つの Host Step と Codex の一つの Codex Turn を同一視せず、Codex が動作中でもホストの制御 Host Step を進められるようにする。

### 7.4 保証する範囲と互換性

子・孫の `parentAgentId`、深さ上限、報告、hook の再入を実機で確認した組み合わせ（Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4、macOS）だけで有効にする。親 ID を上書きしたり、トップレベルに作った agent を子に見えるよう名前で偽装したりしない。

hook からの `$.agent.spawn` は Worker の起動に使わない。親が付かず（main の子として扱われ）、深さ上限も効かず、auto mode では classifier に拒否されるため（[K02]、[K04]、[K11]）。

v1 の Managed-only モード（論理ツリーを Pane にだけ表示する別モード）は持たない。R04 が成り立ったので使う場面が無い。対象版が変わったら、19.1 のゲートを流し直してから有効にする。

## 8. 再帰的な委譲の契約

### 8.1 同じ API を深さ 1・2 で使う

深さ 1 と 2 の Codex に、同じ `delegate` / `inspect` / `wait` / `send` / `configure` / `cancel` の契約を提供する。各起動で caller scope を自動的に狭める。深さ 3 の Codex には、子に関わる tool を出さない（5.1）。

```ts
// 擬似コード：caller は host adapter が tool event と threadId から作る。
async function delegate(caller: Caller, input: DelegateInput) {
  const parent = resolveCallerRun(caller);   // Codex の threadId、または Claude の agentId
  assertParentAcceptsChildren(parent);
  assertDepth(hostDepthOf(caller) + 1);      // 3 を超えたら DEPTH_EXCEEDED
  const resolved = resolveAndValidate(input, parent);
  assertWithinPolicy(resolved, parent);
  assertWithinCapacity(parent, resolved);
  return prepareRun(parent, resolved);       // status: "prepared"
}
```

モデルに `caller` を入力させない。Codex では接続と thread の対応、Claude ではホストの tool event に含まれる agentId から決定する。Claude の subagent が `delegate` を呼ぶ場合も、その agent の Claude Code での深さに 1 を足して Run の深さとする。深さ 3 の Claude の subagent は `Agent` を持たないので、`delegate` の時点で `DEPTH_EXCEEDED` を返す。

### 8.2 delegate は完了待ちしない

返答は `runId`、受理状態、適用された設定、状態確認の方法である。起動拒否や bind の失敗は明示的なエラーとする。

親が子の完了を同じ `delegate` の中で待つ方式は採らない。親が複数の子を起動し、独立した `wait` で結果を集められるようにする。

`wait` は直下の子の Run ID、`mode: all | any`、期限を受け付ける。結果には終端済みと未完了を分けて返す。タイムアウトは `pending` であり、子の停止や失敗を意味しない。祖先待ち、自己待ち、権限のない別ツリー待ちを拒否する。

**待っている間の Worker（Yield と Bell）。** Codex が `bridge_wait` を保留している間、親の Worker は Host Step を開いたまま待たず、次の順に Worker の turn を終えて寝る（[K13]、[K14]）。

1. Bell を起動する。Worker の Host Step が `Bash({ command: "cat <FIFO>", run_in_background: true })` を返す。FIFO は Run ごと・眠りごとに Supervisor が作る。
2. text で Worker の turn を終える。この text は呼び出し元に届かない。

寝ている間も Supervisor は Codex を読み続ける。

- 期限付きの `bridge_wait` の期限が来たら、Supervisor が Host Step を使わずに `pending` で答える。Worker は起こさない。
- Host Step が要る要求（新しい `bridge_delegate`、寝ている間の Codex Turn の終わり）が来たら、Supervisor が FIFO を開いて書き、閉じて Bell を鳴らす。`cat` が終わり、host がその完了通知で Worker を Host Step 0 から起こす。起きた Host Step から 7.3 の経路がそのまま通る。鳴らしてから 10 ms で起き、37〜38 ms で bind して答えた（[K14]）。
- 子が終わると、host が子の完了通知で Worker を起こす。

Bell の完了通知で起きた Worker の turn では、Mod の hook がふだんの resume と同じく Host Step 0 から動く。子の完了通知と同じ起こし方だからである（[K14]）。

Codex は dynamic tool の呼び出しを重ねなかった。`bridge_wait` を await せずに始めるよう指示しても、次の `bridge_delegate` は `bridge_wait` の応答の後に届いた（[K14]）。重なっても、Supervisor は要求の来かたを問わず Bell を鳴らすので、同じ経路で扱える。

`bridge_wait` で長く待つ間も、Codex の model は code mode の `exec` と `wait` で poll し、約 30 秒ごとに request を出す。Bridge の developer instructions で `wait` の `yield_time_ms` を長く（600000）させる（[K03]）。費用は 9.4 で扱う。

### 8.3 結果の回収と親の完了

子の結果は次の不変データとして保存する。

```ts
type RunResult = {
  resultId: string;
  runId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "incomplete";
  summary: string;
  artifacts: ArtifactRef[];
  checks: CheckResult[];
  childResults: { runId: string; resultId: string; outcome: string }[];
  hasUnresolvedIssues: boolean;
};
```

結果は「モデルが成功と言った」だけで succeeded にしない。プロトコル上の正常終了、未解決の子、途中で停止した実行、出力 schema の検証を確認する。テストが通ったという主張を検証済み扱いにするのは、対応する実行記録がある場合だけである。

**Run の完了。** 親の final message が来ても、子が生存していれば Run は完了しない。暫定回答を保存して `waiting_children` とし、子の終端後に一度だけ結果統合用の Codex Turn を許可する。この統合の Codex Turn では新規委譲を拒否する。子の失敗や未完了は統合結果に残す。統合にも失敗した場合は、暫定文を完成品として装わず incomplete を返す。統合の Codex Turn は実機では確かめていない。

**Report の条件。** Worker は次の全てを満たした Host Step でだけ、Report を一度だけ出す（[K12]、[K13]、[K14]）。

- 自分の Run が終端にある。
- 子の Run がすべて終端にあり、子の Worker の turn もすべて終わっている。
- 子の完了通知と Bell の完了通知が、すべて会話に入っている。通知は Host Step の境目か、Worker の turn が終わった後の resume でしか会話に入らない（[K13]）。Supervisor は、子の Worker の turn の終わりと Bell の終わりを見た後に来た Host Step の境目を、通知が入った時点とみなす。

この条件は host が課している。host は、Worker が生きている background の子を持たずに stop したときにしか、呼び出し元へ Report を届けない。子の Worker の turn が終わっただけでは足りず、親がその完了通知を受け取って初めて満たされる。manual mode では、通知を受け取る前に stop した Report は呼び出し元に届かなかった（[K13]）。

**Bell を止めてから Report する。** Bell だけが生きている状態で Worker が stop すると、host は「background の作業を待っている」という途中経過の通知に、stop した text を入れて呼び出し元に届ける（[K14]）。Worker の turn が Report の条件を満たしそうになったら、次の順にする。

1. Supervisor が Bell を鳴らして止める。
2. Worker は stop せず、無害な登録 tool を 1 回呼んで Host Step を進める。
3. Bell の完了通知が会話に入った後の Host Step で Report を出す。

**一度だけ。** Worker は auto mode では、子の `SubagentHandback` と完了通知の 2 回で起こされる（[K12]、[K13]）。`WorkerState.reported` で 2 回目以降を text で終える。resume の後に `SubagentHandback` を呼び直すと `already delivered` が返って Worker の turn が終わらず、Host Step が回り続ける（[K10]）。

初期版では親が終了して子だけ無期限に動く detached delegation を提供しない。

### 8.4 報告経路は一つ選ぶ

| 呼び出し元 | 最終結果の本文の経路 |
|---|---|
| main Claude・Claude の subagent | 最上位の Worker の Report |
| Codex の親 | `bridge_wait` の dynamic tool 応答 |
| 人間の UI | Supervisor の Run の状態を直接参照 |

**Report の手段。** manual mode では、最後の Host Step の text で Report する。auto mode では、最後の Host Step の `SubagentHandback({ message })` の tool chunk で Report する。auto mode で text を返して終えると、engine は Host Step を 3 回まで起こし直し、Report を届けない（[K04]、[K10]）。Bridge は Worker の起動時の permission mode（`agent.spawn` の `permissionMode`）で二つを切り替える。Report を出す時点の mode ではない（T43、#23 の実機）。

- host は、Worker を auto mode で起こしたかどうかで「`SubagentHandback` で返さなければならない」かを決め、後から mode を変えても変えない。manual mode で起こした Worker を途中で auto mode に切り替えても、text の Report が届いた。
- 逆に、auto mode で起こした Worker の Report の前に session を manual mode に切り替えると、Report は届かない。`SubagentHandback` は manual mode の判定で拒否され（`SubagentHandback tool permission denied`。Guard が `allow` を返しても `deny rule overrides` で拒否）、text で終えても「`SubagentHandback` で報告しないまま終わった」と呼び出し元に通知される。Guard の hook の入力の `permission_mode` は、その時点の mode（`default`）になっていた。Mod から今の mode を読む API は無い。
- この場合、呼び出し元が `SendMessage` で Worker を起こすと、Worker は text で答え、その text が呼び出し元に届いた。Bridge は Report を一度しか出さないので、届くのは「報告済み」の text だけである。この穴は初期版では受け入れ、制限として扱う。

auto mode の Report は server 側の classifier に審査されず、「審査できなかった」注記付きで届く。classifier は model の API 応答の上で審査するが、hook が出した Host Step には API 応答が無いため。Mod の側から審査を起こす手段は無い（hook の allow は「Only the auto-mode classifier can allow SubagentHandback」で拒否される）。manual mode の text にも審査は無く、どちらの Report にも harness が untrusted の枠を付けるので、扱いがそろう。これを受け入れる（[K10]）。Report の配送で model の request は増えない。

**Codex の親を持つ Run の Report は receipt だけにする。** runId と resultId を返す。子の Report は親の Worker の会話に完了通知として入るだけで、読むものがいない。Codex の親が受け取る結果本文は `bridge_wait` の応答だけであり、Bridge がホストの通知を Codex に再投入する経路はそもそも無い（[K13]）。

最上位の Run に対する Claude 側の `wait` は、完了状態と receipt を返す。結果本文を別経路で自動プッシュしない。ユーザーが明示的に結果を読み直す操作は許可する。

### 8.5 Codex 内部の Subagent との関係

Codex 自身にも Subagent の仕組みがあり、公開イベント型にも子 Agent の活動がある。[S09][S10] 管理対象の再帰は `bridge_delegate` に統一し、Codex 自身の委譲は止める。止められない構成では Run を起動しない。

**止め方（[K06]、[K08]、[K09]）。**

- Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）の `config.toml` と、app-server の起動引数で、multi-agent・guardian・apps・plugins を止める。`multi_agent` は `-c agents.enabled=false` が要る。model の catalog が v2 を指定するので、`--disable multi_agent` だけでは残る。

  ```sh
  CODEX_HOME=~/.codex-bridge/codex-home codex app-server \
    -c agents.enabled=false --disable multi_agent --disable multi_agent_v2 \
    --disable guardian_approval --disable apps --disable plugins \
    -c approvals_reviewer='"user"'
  ```

- reviewer は起動引数では止まらない。thread に `auto_review` を送ると、`--disable guardian_approval` があっても guardian に回る。Unix では reviewer を強制する requirements を `/etc/codex/` と MDM からしか読まない。そこで Bridge は `thread/start` と `turn/start` に常に `approvalsReviewer: "user"` を送り、公開 API では reviewer を選ばせない。`thread/start` の応答の `approvalsReviewer` が `user` でなければ Run を始めない。
- effort の `ultra` は API で拒否する（5.3）。
- `review/start` を呼ばない。

**起動直後の確認。** `config/read`（`includeLayers`）の実効値と `sessionFlags` 層、`experimentalFeature/list`、`configRequirements/read` で、Bridge の構成になっていることを確かめる。`thread/start` の応答は委譲を有効にした構成と見分けられないので、確認には使わない。rollout の `multi_agent_version` は Codex 内部の file 形式なので読まない。

**tripwire。** 実行中に `collabAgentToolCall`、`subAgentActivity`、`enteredReviewMode` の item、または `item/autoApprovalReview/*` が出たら、Run を止めてエラーにする。子の `thread/started` は親の client に届かないので、手がかりは item にする。Bridge に不具合があれば、止まる前に guardian の判断が 1 回走りうる。このリスクは受け入れる。

この構成では、委譲の tool は model に渡らず（`gpt-5.6-luna` と `gpt-6-luna`、effort の low と ultra のどの組み合わせでも）、呼ばれても `unsupported call` になる。`web.run` や `image_gen` などの委譲でない tool は止めない。

shell から別の CLI（`codex exec` など）を直接起動する経路まで、Bridge だけで禁止できるわけではない。管理対象外の実行を含めた厳密な制限には、実行環境側の制約が要る。この経路は確かめていない。

## 9. スケジューリングと予算

### 9.1 別々に数える資源

| 資源 | 子を待つ親は消費するか |
|---|---|
| Claude Code の agent の枠（同時 20、深さ 3） | ホストの数え方に従う。Yield した Worker が枠に数えられるかは確かめていない。勝手に解放したことにしない |
| app-server プロセスとメモリ | 消費する。Run ごとに一つ |
| Codex の model の request | 消費する。`bridge_wait` の保留中も code mode の `wait` で poll する（[K03]） |
| 実行再開を許す Supervisor の枠 | `bridge_wait` を保留している間は解放できる |
| ツリー全体の時間期限 | 待機中も進む |
| 生成済みノード数 | 終了後も累積値に含める |
| token 使用量 | 実際に provider が報告した分を加算する |

待機中の親から実行枠を戻すのは、Supervisor が `bridge_wait` の応答を保留しており、Codex の再開を制御できる場合に限る。子が終わった後は枠を再取得してから応答を返す。ただし保留中も Codex は poll の request を出すので、費用は枠と別に数える（9.4）。

**hook の予算。** hook の 10 秒の予算は、module 内の Promise を待つ時間も数える。数えないのは `next` と `$` の呼び出し（`$.clock.sleep` を除く）を待つ間だけである（[K05]）。Worker の Host Step が Codex を待つときは、Supervisor への `$.http.fetch` の long poll（一回 30 秒まで）を繰り返し、毎回 `next.signal` を確かめる。1 回の `turn.step` の中で約 20 秒待って、予算の消費は 2 ms だった（[K04]）。

### 9.2 初期値

以下は製品の提案値であり、プロバイダーの制限や性能を示す値ではない。

| 設定 | 提案する初期値 |
|---|---|
| `maxDepth` | 3（Claude Code の深さ。ホストの上限と同じで、これより上げられない） |
| `maxChildrenPerRun` | 4 |
| `maxRunsPerTree` | 16（再試行による増殖も制限） |
| `maxGeneratingRuns` | 4 |
| `maxLiveRuntimeProcesses` | 8（app-server の数。ホストの同時 20 より小さく保つ） |
| `treeDeadline` | 30 分。明示的に延長できる |
| `maxFinalizeTurns` | 1 |
| `preparedTtl` | 5 分（7.2） |
| `bridge_wait` の poll の間隔の指示 | `yield_time_ms: 600000` |

深さはホストの実際の階層で数える。既に Claude の subagent から起動した場合、その agent の深さに 1 を足す（8.1）。ホストの上限に当たった spawn はすぐ失敗し、queue には入らない（[K05]）。

### 9.3 デッドロック回避

起動時点で容量を確保できない場合、親を無期限に保留するのではなく `CAPACITY_EXHAUSTED` を返す。親は自分で処理するか、既に起動した子を待ってから再度明示的に委譲する。

寝ている親が、Host Step を要する要求のために止まり続けることは無い。Supervisor は寝ている間の要求を必ず Bell で知らせ、Worker を起こす（8.2）。期限付きの `bridge_wait` には Host Step を使わずに `pending` を返すので、期限の到来で Worker を起こす必要も無い（[K14]）。

寝ている間の `bridge_delegate` を断る形（「先に委譲してから待て」と返す）は採らない。断ると `gpt-5.6-luna` は 1 回再試行してから作業を諦めた（[K14]）。

最初の実装では複雑な優先度継承より、保守的な admission と明示的な失敗を優先する。

### 9.4 費用と token

本節は紙の上の設計である。ただし、`bridge_wait` の保留中の費用は実機で測った（[K03]）。

**保留中の費用。** `bridge_wait` を保留している間も、Codex の model は code mode の `exec` と `wait` で poll する。一回の request は、その時点までの会話をすべて入力に送る。費用は次で見積もる。

```text
保留中の入力 token ≒ (待ち時間 ÷ wait の間隔) × その時点の会話の長さ（cache に当たる分を除く）
```

試験では会話が短く、一回約 12K token（約半分が cache）だった。`wait` の間隔が 30 秒のまま 15 分保留すると、thread の合計は 348K token になった。developer instructions で `yield_time_ms: 600000` を指示すると、200 秒の保留中の request は 2 回に減った。10 分の間隔が守られるかと、`gpt-5.6-luna` 以外の model が長い `wait` の指示に従うかは確かめていない。選べる model ごとに確かめる（19.2 の T31）。従わない model は 30 秒ごとの起床に戻る恐れがある。

予算は root Run に集約し、子は残予算の一部を予約する。同じ provider usage snapshot を何度も足さず、Codex Turn の ID と更新時点を用いて重複を防ぐ。

表示は「現在のコンテキスト」「その Run の累積消費」「子孫を含む累積消費」「`bridge_wait` の保留中の消費」を分ける。キャッシュ入力が入力合計の内数かどうかを provider adapter で明示する。

金額換算は利用プラン・provider・価格表によって異なるため、初期版は取得できた token 実績を主指標とする。正確な価格が不明なら金額を表示しない。token 報告の遅延があるため、ローカル監視だけで請求額の厳密な上限を保証しない。

## 10. 権限と承認

### 10.1 脅威モデル

想定するのは、リポジトリやツール出力に含まれる指示へモデルが誘導され、過剰な子起動、範囲外の書き込み、権限昇格要求を行う状況である。Bridge はモデルを control API の信頼主体にしない。

もう一つ、Mod が Worker の turn を握れず、Worker が model として動く状況を想定する（7.1）。Worker は `Agent` と Bash を持つので、守りが無ければ子を起こし、任意のコマンドを実行できる。prototype では、Mod の module が消えた後の Worker が `general-purpose` として `Agent` で子を承認なしで起こした（[K16]）。

同じ OS ユーザー権限を持つ任意の敵対プログラムから完全に隔離する仕組みは、本製品単独の範囲外とする。Unix socket や state の directory の mode だけで、同じユーザーの無制限プロセスを完全に防げるとは主張しない。

### 10.2 権限は profile ではなく能力として比較する

内部表現では読み取り範囲、書き込み範囲、ネットワーク、許可されたモデル/provider、最大委譲範囲を明示する。

```text
childCapabilities
  ⊆ userDelegationGrant
  ∩ organizationPolicy
  ∩ parentDelegatableCapabilities
  ∩ providerEnforceableCapabilities
```

sandbox の名前だけを大小比較しない。二つの `workspace-write` でも、書き込み可能なディレクトリが異なれば同じ権限ではない。正規化したパス、symlink、作業領域の実体を検査する。事前の realpath 確認は TOCTOU 対策の完全な代わりではなく、最終的な書き込み制約は provider / OS 側でも強制する。

初期 UI は read-only と workspace-write を基本とし、無制限権限は通常のモデル公開引数に出さない。`approvalPolicy` や `sandbox` の既定より緩い値は、ユーザーの grant が無ければ拒否する。モデルが勝手に緩い値を足す観測がある（[K11]）。Claude Code の許可ルールを Codex が自動的に継承すると仮定しない。

### 10.3 host の権限の判定と、Bridge の段取り

Bridge が Claude Code の中で出す tool 呼び出しは、どれが host の権限の判定を通るかを決めておく。

| 呼び出し | 誰が出すか | 判定 |
|---|---|---|
| `delegate` | main・Claude の subagent の model | Mod の `tool.call` が `next(e)` で host の判定に回す。auto mode は classifier が task を審査し、manual mode はユーザーの承認か allow rule |
| 2 段目の `Agent`（Worker の起動） | main・Claude の subagent の model | auto mode は Mod の `tool.check` が 7.2 の三条件で許可する。manual mode は host の通常の判定で通る（[K11]）。三条件から外れた呼び出しは、どちらの mode でも Mod の `tool.check` の deny が効いた（#23 の実機、T35） |
| 子の `Agent`、Bell の Bash、登録 tool | Worker の Host Step（Mod が返す tool chunk） | Guard が Permit を確かめて `allow` する |
| `SubagentHandback`（auto mode の Report） | Worker の Host Step | Guard は Permit を確かめた上で判定を返さず、host の通常の扱いに回す |
| Worker の model が出した呼び出し | Mod が Host Step に答えていない Worker | Guard が拒否する |

この表の根拠と制約は次のとおり。

- **classifier が審査するのは `delegate` の task である。** Mod が答える登録 tool は、`next()` を呼ばない限り権限の判定を通らない。[K11]〜[K14] の prototype の `delegate` は判定を一度も通っておらず、classifier が見ていたのは prompt が runId だけの `Agent` だった（[K15]）。中身を持つ呼び出しを審査させるため、`delegate` は必ず `next(e)` を呼ぶ。`next()` の先には登録 tool の実体が無く `no tool.call hook answered this call` の ERROR が log に出るが、Mod はそれを捨てて自分の結果を返す。
- **auto mode では、`Agent(...)` の allow rule は使えない。** auto mode に入るとき、host は全ての出どころ（user・project・local・flag・managed・CLI 引数・session）の allow rule から、tool 名が `Agent` のものを内容に関わらず外す（[K15]）。Mod の `tool.check` の許可は、auto mode では classifier を経ずに採られる。その副作用として、main の会話に「Mod の `tool.check` hook が skip された」という通知が毎回入る。動作には影響しないので受け入れる。
- **Worker の Host Step が出す呼び出しは、Mod の `tool.check` や `classic.PreToolUse` では守らない。** manual mode では組み込みの `cc-plugin-sec-default` が先に判定し、Mod の hook は飛ばされる。auto mode でも `classic.PreToolUse` は飛ばされる。どちらも Mod が居ない場面では効かない（[K14]、[K16]）。plugin の `hooks.json` の `allow` は、manual mode の確認も auto mode の classifier も飛ばして採られる（[K16]）。
- **Mod が作った Host Step の呼び出しには、server 側の classifier の判定が付かない。** rule も Mod の許可も無ければ、auto mode では fail closed で拒否される（[K15]）。Guard の `allow` がこれを通す。
- **`SubagentHandback` は Guard でも `allow` しない。** host は「SubagentHandback を allow できるのは auto mode の classifier だけ」として、hook の allow を tool error にする（[K10]）。Guard は Permit のある `SubagentHandback` に判定を返さず、host の通常の扱い（判定なしの注記付きで配送）に回す。これは [K16] の「Permit のある呼び出しは全て `allow`」から外れる。T33（#23 の実機）で、plugin の `hooks.json` の Guard が `allow` を返す場合も確かめた。host は `Hook returned 'allow' for SubagentHandback, but … requires the full permission pipeline` として allow を捨て、判定なしと同じく注記付きで一回配送した。どちらでも届くので、host の扱いどおりの判定なし（`none`）を採る。

### 10.4 Guard

Guard は plugin の `hooks/hooks.json` の `PreToolUse`（matcher `*`）に置く command である。Mod の hook が外れた Worker の turn でも、Mod の module が消えた後でも働く（[K16]）。

**判定。**

1. 入力の `agent_id` が Worker Roster に無ければ、判定を返さない。main や Claude の subagent の呼び出しには関わらない。
2. Worker Roster に載った agent の呼び出しで、`tool_use_id` の Permit があれば、Permit を消してから `allow` する（`SubagentHandback` は判定を返さない。10.3）。
3. Worker Roster に載った agent の呼び出しで Permit が無ければ、tool を問わず拒否する。`SubagentHandback` も拒否する。守りの外で model が書いた Report は信用できない。拒否された Worker の呼び出し元には「報告なしで終わった」が届く。

**Permit。** Mod が Worker の Host Step で返す tool chunk（子の `Agent`、Bell の Bash、登録 tool、`SubagentHandback`）は、全て Permit を通す。Supervisor が chunk の `tool_use_id` を決め、その名前で Permit の file を書いてから Mod が chunk を返す。Mod が chunk に付けた `tool_use_id` は、settings hook の入力にそのまま届く。model の呼び出しの id は API が付ける（`toolu_01…`）ので、model は Permit のある id を選べない。Permit は一回限りで、Guard が使ったら消す（[K16]）。

**Worker Roster。** Supervisor が bind の command を受けた時点で Worker の `agent_id` を書き、session の間は消さない。それより前の Host Step 0 は、Mod が `next` に流さないことで守る（7.1）。Run を終えた Worker が後から起こされても、何もできないようにするため。Worker Roster は Mod や Supervisor より長く残る必要がある（3.3）。

**fail closed の形。** Guard の command は、script の file が無くても、Worker Roster に載った agent なら deny を返す形にする。例えば command 自体が Worker Roster を見て、script が無ければ deny を返す。script が無いときの status 127 は、host にとってブロックしないエラーで、fail open になった（[K16]）。Worker Roster に載っていない agent は素通しにし、plugin の path が消えても session 全体は止めない。

Guard は session の全ての tool 呼び出しで起動される短い command なので、起動の速い sh で書く。

**実装の形（#22）。**

- Supervisor の command は `roster.add { agentId }` と `permit.issue { agentId, tool }` である。`permit.issue` は Worker Roster に無い agent には `STATE_CONFLICT` を返し、`tool_use_id`（`toolu_cb` と 24 桁の hex）を決めて返す。`agentId` は `[A-Za-z0-9_-]{1,128}` に限る。Guard がこの id から file の path を作るため。
- Permit の file は `{ agentId, tool, decision }` の 1 行の JSON である。`decision` は `allow` か `none`（判定を返さない）で、`SubagentHandback` の Permit だけが Supervisor の `--handback-decision allow|none`（既定 `none`）に従い、他は `allow` になる。Mod は T33 の結果の `none` を明示して Supervisor を起こす（#23）。Guard は `rename` で Permit を取ってから読むので、同じ Permit を二つの呼び出しが使うことはない。Permit の `agentId` が呼び出しの `agent_id` と違えば拒否する。
- Guard は Worker Roster を、入力の `session_id` ではなく `sessions/*/roster/<agent_id>` で探す。session の id の食い違いで fail open にならないようにするため。実機では、Claude の subagent の hook の入力にも main と同じ `session_id` が入っていた。
- Guard の script が無いとき、`hooks.json` の command は Worker Roster の名前を入力の `"agent_id":"<名前>"` と照らし、当たれば status 2 で拒否する。jq が入力を読めないときの guard.sh も同じ照合で拒否する。実機（2.1.309）で、script を消した plugin が Worker Roster に載せた subagent の Bash を拒否し、main の Bash を通した（T34）。

**既知の制限。** `/plugin disable` や uninstall で plugin を外すと、Guard も消える（[K16]）。外すのはユーザーが意図して行う操作で、Supervisor も止まるので Bell は鳴らない。ただし Worker は子の完了通知では起き、`general-purpose` として動く。manual mode では Bash や Edit に承認が出るが、`Agent` と Read はそのまま通る。auto mode では classifier が審査する。この穴は受け入れる。

### 10.5 承認の状態

本節は紙の上の設計である。

Bridge は `approvalsReviewer: "user"` を固定するので、Codex の承認要求（`item/commandExecution/requestApproval` など）は Supervisor に届く（[K09]）。Supervisor は Run を `waiting_user` にし、Pane の承認 UI でユーザーに判断を求める。

承認レコードには `approvalId`、run / thread / Codex Turn / item、要求内容のハッシュ、期限、必要な主体、decision を保持する。

状態遷移は `pending → granted | denied | expired | cancelled`。一度終端した要求を再利用しない。要求の変更では新しい承認を必要とする。Supervisor が止まれば、未決の承認は Run と一緒に消える。

ユーザーには、何の実行か、どこへの書き込みか、ネットワークが必要か、単発か Codex Turn 単位かを表示する。通常メッセージの `approve`、タスク文中の「許可済み」、親 Codex の自己判断はユーザーの承認ではない。

provider がサポートする scope 以上に広い権限を渡さない。許可の強制に使える API がない権限は、独自の UI を付けただけで強制済みと呼ばない。[S07]

### 10.6 認証情報

Codex の認証は Codex CLI の責任とする。Bridge は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`、mode 700）を使い、ユーザーはそこで一度 `codex login`（ChatGPT）を行う。Bridge は認証ファイル（`auth.json`）の中身を読まず、書き換えず、転送しない（[K06]、[K08]）。

`CODEX_HOME` を分けるのは、個人の `~/.codex/AGENTS.md` と、個人の config の MCP server を Bridge の Codex に読ませないためである。`baseInstructions`、`developerInstructions`、`project_doc_max_bytes=0`、`-c mcp_servers={}` では消えず、確実に外せるのは `CODEX_HOME` を分けることだけだった（[K06]）。

Mod と Supervisor の間に token 認証は置かない。socket は mode 700 の directory に置き、同じユーザーの process からの保護は 10.1 の範囲外とする。Supervisor の内部の操作 capability と Permit を、Codex のプロンプト、子プロセス環境、ツール引数、通常ログへ載せない。Codex には自分の dynamic tool 接続を通じた限定された操作権だけを与える。

MCP の結果や子の報告も外部データであり、管理ポリシーへ変換しない。モデルが読む内容と、システムが採用する制御フィールドを分離する。

## 11. 作業領域とコンテキスト

### 11.1 作業領域の三モード

本節は紙の上の設計である。

| モード | 用途 | 制約 |
|---|---|---|
| `shared-read` | 調査・レビュー | 書き込み不可。何を読んだかの revision を記録 |
| `isolated-write` | 実装・修正 | 子ごとの独立 worktree / snapshot。通常はこちら |
| `exclusive-write` | 同じチェックアウトでの単独作業 | その領域の排他的な書き込み所有権を確保 |

worktree はファイル衝突を避ける作業領域であって、セキュリティ境界ではない。親と子に同じ書き込み領域を同時付与しないことを既定にする。

レビュー対象が未 commit の変更なら、単に HEAD から worktree を作るだけでは対象が消える。信頼された作業領域管理処理で対象差分の snapshot を用意し、元 revision、差分ハッシュ、未追跡ファイルの扱いを記録する。秘密ファイルや無関係な untracked ファイルを自動複製しない。

隔離した子の変更は、そのまま親のチェックアウトへ自動適用しない。成果物として差分と検証結果を返し、親の統合手順で競合を確認する。子の別 worktree を書き込み可能にする場合も、親に認めた委譲用領域の grant 内で作成する。

### 11.2 コンテキストは明示して渡す

子に渡すのはタスク、関連ファイル参照、選択した成果物、受け入れ条件、子が必要とする範囲のプロジェクト指示である。親の全会話や、親モデルの非公開推論をコピーしない。

**Codex が読む指示の出どころ。** Bridge の Codex が読む指示は、Bridge が渡す developer instructions と、作業する repo の `AGENTS.md` だけにする。個人の `~/.codex/AGENTS.md` は `CODEX_HOME` を分けて外す。ephemeral の `thread/start` の `instructionSources` が `[]` になることを確かめた（[K08]）。個人の skill の一覧（`~/.agents/skills`）は `CODEX_HOME` を分けても developer message に入る。これは許容する（[K03]）。

Bridge の developer instructions には、少なくとも次を書く。

- `bridge_wait` などの dynamic tool の待ちでは、code mode の `wait` を `yield_time_ms: 600000` で呼ぶ（9.4）。
- `bridge_wait` の結果は返った text をそのまま読む（5.6）。

Codex が自分の環境で読む指示ファイルと、Bridge が追加したコンテキストを区別して記録する。Claude の指示・skill を Codex が自動継承するとは扱わない。明示的に渡す場合は出所とハッシュを付け、ユーザーが送信範囲を確認できるようにする。

成果物の参照は、パスだけでなく content hash と範囲を持たせる。依頼中にファイル内容が変わった場合は、同じ内容を読んだと見せない。

## 12. 実行プロトコルと接続

### 12.1 Mod ↔ Supervisor

Mod は Supervisor を `$.process.spawn` で起動する。起動は最初に必要になった時点で行い、session の開始時には起動しない。同時に起動しかけたときは、module 変数の Promise 一つにまとめる（[K07]）。`$.process.spawn` の子は、loop を抜けたとき、`next.signal` が abort したとき、module が unload されたときに kill される。

spawn は、必要とした hook の `$` では行わない。`tool.call` の中で spawn した Supervisor は、ユーザーの Esc で dispatch が abort されると一緒に kill された（#21 の実機）。そこで Mod は `session.start` の hook から起動役の loop を一つ回し、必要になった hook はその loop に起動を頼む。spawn は `session.start` の `$` で行うので、頼んだ dispatch の abort では止まらない。`$` は module 変数に入れられない（`claude plugin validate` が拒む）ので、loop の引数で持つ。起動の時点は「最初に必要になったとき」のままである。module の reload では host が Supervisor を kill し、reload で `session.start` が走り直して新しい起動役の loop ができる（#21 の実機）。`/reload-plugins` では module は読み直されず、Supervisor も残った。

通信は Unix domain socket 上の小さな HTTP に限る。`$.process.spawn` の stdout は起動完了の合図と診断にだけ使う。stdin は一度しか書けず、stdout は行の途中で切れるため（[K07]）。socket は `/tmp/<短い名前>/`（mode 700）に置く。socket の path は約 100 byte までなので、長い directory には置けない（[K04]）。一つの session から複数の path に `$.http.fetch` できることは確かめた。

通信は次の二系統とする。

- `command`: 起動、Host Step の問い合わせ、bind、`wait` などの操作。
- `events(afterCursor)`: Run ごと、または Pane 用の event の long poll。一回 30 秒まで。Mod は毎回 `next.signal` を確かめる。

`$.http.fetch` は signal を取らないので、hook の中の long poll は fetch と `next.signal` の abort を競わせ、abort が先なら結果を待たずに返る。実機では、Esc から 3〜4 ms で hook が返った。abort した fetch の完了は host の debug log に出なかった（30 秒の上限を過ぎても）。Supervisor 側も 30 秒で応答を返して終わる（#21）。Bun の `Bun.serve` は unix socket でも既定で 10 秒の idle timeout で接続を切るので、Supervisor は `idleTimeout: 0` で待つ（#21 で確かめた）。

Mod が streaming body を扱えることに依存しない。一回の応答は 256 KiB 以下とし、出力全文は別のページ取得にする。heartbeat、lease、所有 epoch、token は持たない（ADR 0001）。

Supervisor は親 process（Claude Code）の消失を周期的に確かめ、消えていたら各 app-server の process group を止めてから終了する。Claude Code が異常終了したときの `$.process.spawn` の子の扱いは、型宣言に書かれていないため（ADR 0001）。周期は 1 秒で、親の pid が消えたか ppid が変わったかを見る。実機では Claude Code を SIGKILL すると、Supervisor は約 0.5 秒で socket を消して終わった。Supervisor は Claude Code と同じ process group にいるので、Claude Code の端末が閉じると SIGHUP も届く。SIGTERM・SIGINT・SIGHUP でも socket を消して終わる（#21）。

reload の直後は、前と後の Supervisor が同じ socket の path を使いうる。Supervisor は起動時に残った socket を消して listen し、終了時には自分が作った inode のときだけ消す。`Bun.serve` の `stop()` は path を無条件に消すので、終了時に呼ばない。

### 12.2 Supervisor ↔ Codex

一つの Run につき一つの app-server プロセスを、Bun の child process で stdio につないで持つ。[S12]Run を止めるときに、その app-server の process group をまとめて止められるようにするため。一つの app-server で複数の thread を並行して扱えることは確かめたが、それでは一つの Run のコマンドの子 process を確実に止められない（[K04]、[K07]）。`--listen unix://` では切り離さない（3.2 の将来の移行先を除く）。

接続ごとに `initialize` / `initialized` を行う。実験的機能（dynamic tool）を使うので、明示的に opt-in する。

| 内部操作 | Codex への接続 |
|---|---|
| 新しい会話 | `thread/start`（model と `dynamicTools`。effort は渡さない） |
| 会話の再利用 | `thread/resume`（Supervisor の寿命の中だけ） |
| 仕事の開始・次の Codex Turn | `turn/start`（毎回 model と effort を明示。`approvalsReviewer: "user"`） |
| 進行中の Codex Turn への追加指示 | `turn/steer` |
| Codex Turn の中断 | `turn/interrupt` |
| 出力の読み直し | `thread/items/list`、`thread/read` |
| 子の制御要求 | `item/tool/call` への応答 |

**thread と Codex Turn の渡し分け（[K17]）。** `thread/start` には model だけを渡す。`thread/start` に effort の欄は無い。`turn/start` の model と effort は以後の Codex Turn に残り、何も渡さない Codex Turn は前の値を使う。`thread/resume` は最後の値を引き継ぎ、model だけを渡すと effort が null になって、Bridge から見えない catalog の既定値で動く。そこで、`thread/resume` の後の最初を含む毎回の `turn/start` で、`resolved` の model と effort を両方明示する。

`dynamicTools` は `thread/start` でしか登録できず、thread と一緒に保存される。`thread/resume` に渡さなくても使える（[K03]）。深さ 3 の Run では、`thread/start` の `dynamicTools` から子に関わる tool を外す（5.1）。

使わない API は、`thread/settings/update`、`turn/settings/update`、`review/start` である（5.5、8.5）。CLI の文字列フラグ列を公開契約にせず、プロセス単位の設定は 8.5 の起動引数と Bridge 専用の `CODEX_HOME` から与える。[S08]

**保留中の呼び出しの取り消し（[K03]）。** `turn/interrupt` は `{}` を即座に返し、保留中の `item/tool/call` を取り消す。取り消しの専用通知は無い（`serverRequest/resolved` は出ない）。Supervisor は `dynamicToolCall` の `item/completed`（`status: failed`）と `turn/completed`（`interrupted`）で取り消しを知り、保留中の操作を片付ける。遅れて送った応答は、エラーも無く捨てられる。stdin が閉じると app-server は 11 ms で終わり、保留中の呼び出しは取り消される。

### 12.3 双方向通信で詰まらない

stdout の読み取りループは、子の完了や承認を await して止めない。受信はデコード・検証・キュー投入までに限定し、server request の処理は別の非同期タスクで行う。write は一つの直列キューで行う。

そうしないと、親が子を待つ要求の処理中に、同じ接続の停止通知やエラーが読めなくなる。保留 RPC の件数、出力量、キューサイズに上限を設定し、拒否できる過負荷と配送不明を分ける。

## 13. イベントと保存

### 13.1 内部イベント

```ts
type BridgeEvent = {
  schemaVersion: 1;
  runId: string;
  seq: number;                   // Supervisor が発行するローカル順序
  observedAt: string;
  origin: "codex" | "host" | "supervisor";
  kind: string;
  providerRef?: {
    threadId: string;
    turnId?: string;
    itemId?: string;
  };
  payload: unknown;              // kind ごとの schema で検証する
};
```

Run に属さない Supervisor の event（`supervisor.started`、診断の `ping`）は、`runId` と `providerRef` を持たない `SupervisorEvent`（`origin: "supervisor"`）として同じ `seq` の列に流す。

`seq` は Mod の long poll の cursor であり、Supervisor の寿命の中でだけ意味を持つ。Supervisor は自分の `seq` より先の cursor を `STATE_CONFLICT` で断る（前の Supervisor の cursor を持ち越した場合）。一つの event が応答の上限を超えるときは、その event の代わりに大きさだけを載せた `event.omitted` を返す。項目のキーは run / thread / Codex Turn / item の組にする。app-server は Run ごとに別の process なので、別プロセスの数値 request ID が一致しても混線しない。

### 13.2 項目の状態更新

`item/started` で項目を作り、delta を更新し、完了 snapshot で確定する。完了時の集約出力を delta の末尾へ単純連結して二重表示しない。必要なら確定出力を正として置き換え、取得できなかった区間を表示する。

Codex Turn が中断されたのに項目の完了通知が来ない場合、項目を永遠に running にしない。Codex Turn の終端から「中断」「状態不明」を導出し、その状態が推定であることを記録する。exit code を作り出さない。

未知の通知は安全に無視できる observation と、回答が必要な server request を分ける。未対応の要求には明示的な unsupported を返し、無条件の許可や成功にしない。

### 13.3 保存方式

Supervisor は SQLite を持たず、Run・操作・結果・UI 用の項目を memory だけに置く（ADR 0001）。Supervisor が止まれば、これらは消える。

| 保存先 | 内容 |
|---|---|
| Supervisor の memory | Run の状態、設定（requested / resolved / observed）、保留中の操作、承認、UI 用の項目、結果 |
| Codex（Bridge 専用の `CODEX_HOME`） | thread と item。出力の全文は `thread/items/list` で読み直せる |
| `~/.codex-bridge/sessions/<sessionId>/roster/` | Worker Roster（`agent_id` ごとの file） |
| `~/.codex-bridge/sessions/<sessionId>/permits/` | Permit（`tool_use_id` ごとの file。一回限り） |
| `~/.codex-bridge/sessions/<sessionId>/bells/` | Bell の FIFO（Run ごと・眠りごと） |

memory の UI 用の項目と出力には、件数と大きさの上限を設ける。上限を超えた出力は、項目に省略を表示し、全文は Codex から読み直す。

state の directory は mode 700 で作る。終わった session の directory は、Supervisor の起動時に一定の期間を過ぎたものから消す。session の間に消すと Guard が fail open になるので、自分の session の directory は消さない。期間は 7 日とする。最後に使った時刻は、directory 自身とその直下の項目（`roster/` など）の mtime のうち最も新しいものとし、Supervisor は自分の session の directory を起動時と 6 時間ごとに touch する。session の長い休止の後に、別の session の Supervisor が消さないようにするため（#21）。

後から Conversation の再利用を Supervisor の寿命の外へ広げるなら、Conversation から thread ID への対応表を保存すれば足りる（ADR 0001）。

認証情報は保存対象から除外する。通常ログは redaction するが、それだけで秘密を完全除去できるとはしない。Codex 側の会話保存も別に存在するため、Bridge 側の削除が Codex の履歴まで削除したことにはならない。

## 14. メッセージ配送と停止した Run

### 14.1 入力を受けた場所で識別する

Claude の tool event、ユーザーの入力 action、Codex の dynamic tool request のそれぞれに識別子を付ける。会話全文の文字列を検索して「まだ実行していない依頼」を抽出することを配送の基盤にしない。

ユーザーの追加指示は Bridge の入力 action で受ける。Worker の agent view への入力は Mod の手の外で Worker を起こすので、Bridge への指示として扱わない（7.1）。

### 14.2 冪等性の単位

同じ操作の再試行は同じ `(caller, requestKey)` で扱い、payload hash が同じなら同じ受理結果を返す。キーが同じで payload が違う場合は `IDEMPOTENCY_CONFLICT` にする。別の tool call で同じ依頼文を送るのは別操作である。冪等性は Supervisor の寿命の中でだけ保つ。

```text
prepared → submitted → acknowledged → completed
                  └→ failed
```

`submitted` は送信を試みたこと、`acknowledged` は provider が受理したこと、`completed` は仕事が終わったことを表す。三つを混同しない。

### 14.3 不明な配送を自動再送しない

`turn/start` の送信後に app-server が終わった場合、仕事が開始済みかもしれない。app-server は stdio で Run と一緒に持っているので、接続の作り直しはせず、Run を `failed` にして、実行済みの変更とともに人間へ示す。同じプロンプトを別の thread へ自動送信しない。

同様に、`Agent` を呼んだ後に bind が確認できない場合、二つ目の Worker を起動しない。

### 14.4 dynamic tool 応答の扱い

子の Run を作った後で、親への `bridge_delegate` の応答が届かない場合がある（親の Codex Turn が中断されたなど）。このとき子を再作成しない。子の Run は Run A の子として残り、Run A の停止の対象になる。

応答を書き込んだことと、Codex がそれを受け取ったことは別である。中断の後の応答はエラーも無く捨てられる（[K03]）。対応する `item/completed` を確認できた場合のみ受け取られたと記録する。

保留中の呼び出しは JSON-RPC の request id ではなく `callId` で突き合わせる。request id は接続ごとに振り直され、送り直しでも同じ値（`0`）が再利用された（[K03]）。

### 14.5 reload・session の終了・異常終了

Mod の reload と session の終了では、host が Supervisor を kill する。app-server は stdin の EOF で終わり、実行中の Codex Turn と保留中の呼び出しは止まる（ADR 0001、[K03]、[K04]）。Bridge は止まった Run を再開しない。

reload の後に新しい Supervisor が起動すると、前の Supervisor の Run を知らない。寝ていた Worker の Bell は、前の Supervisor の FIFO で止まったままになる。Bell だけが生きている Worker が Report すると、呼び出し元に途中経過の通知が届く（8.3）。そこで新しい Supervisor は、起動時にその session の bells の FIFO をすべて鳴らしてから消す。前の Run の Worker の Host Step が届いたら（子の完了通知で起こされたなど）、Supervisor は「Run は reload で停止した」という失敗を返し、Worker はそれを Report して終わる（ADR 0001）。Worker Roster は file なので、前の Worker も Guard に守られたままである。

前の instance の Worker を `TaskStop` で止められるかは確かめていない（21 章）。

## 15. 停止とライフサイクル

### 15.1 停止の種類

| 操作 | 意味 |
|---|---|
| 画面を閉じる | 実行は変えない |
| 追加入力を取り消す | 未配送メッセージだけを取り消す |
| Run を停止 | その仕事と既定で子孫を停止する |
| tree を停止 | root 以下を停止する |
| Mod の reload・session の終了 | Supervisor が止まり、全ての Run が止まる |
| Claude Code の消失 | Supervisor が親の消失を検出し、app-server を止めて終了する |

`turn.step` の終了、Yield、stream consumer の終了、描画の切り替えは、それだけでは Run の停止要求ではない。ホストの実際のキャンセル操作と、正常な制御 Host Step の終了を adapter で区別する。区別できない abort は状態を照合し、稼働継続が危険な場合は安全側に停止して理由を記録する。正常な子起動や Yield のために Worker の turn を返しただけで、親の Codex を kill しない。

### 15.2 子孫への伝播

停止要求の最初に、対象 subtree の新規 admission を閉じる。停止と同時に届いた子起動要求は同じ境界で拒否し、`prepared` の子の Run は `cancelled` にする。その後に未配送メッセージを取り消し、承認を無効化し、各 Codex Turn へ interrupt を送る。寝ている Worker は Bell で起こし、停止を Report させる。

`turn/interrupt` の返答を、全ての OS プロセスが消えた証拠にはしない。Codex Turn の終端を待ち、必要に応じて app-server の process group への終了要求を行う。

提案する猶予は interrupt 後 3 秒、TERM 後 2 秒。これは製品の設定値であり、必ずその時間で全処理が止まるという保証ではない。停止確認が取れない項目は `cleanup_pending` として診断に残し、cancelled と断定しない。

停止は既に行ったファイル変更や外部 API 呼び出しをロールバックしない。UI には残った変更を提示する。

### 15.3 Supervisor の異常終了と孤児

Supervisor が異常終了したら、app-server は stdin の EOF で終わる。中継を SIGKILL しても、子の app-server は 2 秒以内に終わり、孤立しなかった（[K04]）。Mod は spawn の loop で終わりを観測し、Pane に表示する。次に Supervisor が要るときに起動し直す。前の Run は 14.5 と同じく停止として扱う。

本節の停止の振る舞いは G06 にあたり、macOS で異常終了の試験をしてから supported とする。

## 16. エラーと診断の契約

全ての公開操作は、成功と失敗を構造化して返す。エラー文の文字列一致で次の状態を決めない。

```ts
type BridgeError = {
  code:
    | "INVALID_INPUT" | "MODEL_UNAVAILABLE" | "EFFORT_UNSUPPORTED"
    | "POLICY_DENIED" | "HOST_DENIED" | "CAPACITY_EXHAUSTED" | "DEPTH_EXCEEDED"
    | "HOST_CAPABILITY_MISSING" | "HOST_BINDING_FAILED" | "RUN_EXPIRED"
    | "PROVIDER_CAPABILITY_MISSING" | "SELF_DELEGATION_DETECTED"
    | "APPROVAL_REQUIRED" | "APPROVAL_EXPIRED" | "IDEMPOTENCY_CONFLICT"
    | "STATE_CONFLICT" | "RUNTIME_EXITED" | "SUPERVISOR_RESTARTED"
    | "UNSUPPORTED_REQUEST" | "CANCELLED";
  message: string;
  retry: "never" | "after-capacity" | "after-auth" | "after-user";
  operationId?: string;
  runId?: string;
  details?: Record<string, unknown>;
};
```

v1 から足したコードは次のとおり。

| code | 意味 |
|---|---|
| `HOST_DENIED` | host の権限の判定（classifier やユーザー）が `delegate` を拒否した |
| `RUN_EXPIRED` | `prepared` の Run が期限までに bind されなかった |
| `SELF_DELEGATION_DETECTED` | 8.5 の起動直後の確認か tripwire に当たった |
| `SUPERVISOR_RESTARTED` | reload などで前の Supervisor の Run が止まった |

v1 の `DELIVERY_UNKNOWN` と `retry: "after-reconcile"` は、照合の手順を持たないので外した。

診断画面には Claude Code・codex-cli・Bun の版、schema hash、permission mode、plugin と Guard の有無、Worker Roster の件数、Run の bind、最後の provider event、保留操作数、8.5 の起動直後の確認の結果を表示する。認証 token とファイルの秘密内容を診断 bundle に含めない。

登録 tool の失敗は、BridgeError を JSON の text にして返す。host は hook の答えを tool の出力の形に照らし、`result` に object を返すと `does not match its output shape` の tool error に変える（#23 の実機）。

未知のエラーを「Codex が未インストール」と一括表示しない。起動失敗、認証失敗、schema 不一致、権限拒否、実行中のエラーを分ける。

## 17. コードと配布の構成

### 17.1 初期版の構成

```text
（repo の直下）
  packages/
    contracts/
      src/schema.ts          # schema をデータで書く小さな DSL。検証器・TypeScript の型・JSON Schema をここから導く
      src/schemas/           # 入力・結果・イベントの定義
      src/permissions.ts     # 既定より緩い権限を grant と照らす判定
      src/errors.ts

    supervisor/
      admission/             # 設定解決、catalog の検証、制約、予算予約
      runs/                  # Run と Worker の状態、親子、結果回収、Report の条件
      provider/              # Codex stdio / RPC / 型変換、起動直後の確認、tripwire
      host/                  # Worker の次の Host Step の決定、Permit、Worker Roster、Bell
      workspaces/            # snapshot / worktree / ownership
      control/               # Unix socket の HTTP（command / events）
      main.ts

    claude-mod/
      hooks/register.ts      # 登録 tool、Worker 型、turn.step、agent.spawn、tool.check
      host/                  # Host Step の翻訳、Report の手段の切り替え
      control-client/        # Supervisor の起動と long poll
      ui/                    # Run ツリー、項目、設定、承認
      compatibility/         # 対応版ごとの最小差分
      types/                 # 同梱の claude-code.d.ts
      guard/guard.sh         # Guard。Worker Roster と Permit を見る
      hooks/hooks.json       # PreToolUse、matcher "*" で Guard を呼ぶ
      .claude-plugin/plugin.json

  tests/
    contract/
    state-machine/           # Supervisor を Claude Code なしで試す
    protocol-fixtures/
    host-integration/
    end-to-end/
  compatibility/
    supported-builds.json
```

contracts は純粋なデータと検証のみで、Bun や Claude Code を import しない。実行時の依存も持たない。生成の段を置かず、schema のデータから型と検証器を導くので、両者がずれない。Supervisor は Claude の会話ラッパーや JSX を知らない。Mod の UI は provider RPC を直接呼ばない。Mod は Run の正本を持たず、Supervisor が決めた Host Step をそのまま返す。

v1 の `supervisor/storage/` と `bootstrap.ts` は持たない（ADR 0001）。初期段階で汎用 Repository フレームワークや多 provider 抽象を追加しない。

Mod 側の配布コードは、対象ホストが読み込める JS/TS モジュールへ bundle し、Node / Bun の組み込み API を混入させない。Supervisor 用の依存は Mod の実行環境へ持ち込まない。[S01] Guard は plugin と一緒に配布し、Mod とも Supervisor とも依存を共有しない。

### 17.2 バージョンと配布

互換性 manifest には次を記録する。

```json
{
  "bridgeVersion": "2.0.0-dev",
  "claudeCode": {
    "version": "2.1.309",
    "declarationSha256": "GENERATED_AT_BUILD",
    "gates": { "G01": "conditional", "G02": "pass", "G03": "conditional", "G05": "pass", "G08": "conditional" }
  },
  "codex": {
    "version": "0.163.0",
    "schemaSha256": "GENERATED_AT_BUILD",
    "gates": { "G04": "conditional", "G09": "conditional", "G10": "conditional" }
  },
  "runtime": {
    "bunVersion": "1.4.4",
    "platform": "darwin"
  }
}
```

gates の値は prototype の判定であり、製品のコードで流し直して上書きする（20 章の段階 B）。任意の最新版へ自動更新して互換性を保てるとは仮定しない。版が変わったら記録し、ゲートを流し直す。

導入は 5.1 の手順に従う。Bridge は既存のグローバル Codex 設定（`~/.codex`）、Claude の設定、認証情報を書き換えない。インストール時に、補助プロセス（Supervisor と app-server）、保存場所（`~/.codex-bridge/` と `/tmp` の socket）、Guard が全ての tool 呼び出しで動くことを明示する。

## 18. 代表シナリオ

### 18.1 親・子・孫によるレビュー

1. 親 Claude が構造化した `delegate` を呼ぶ。Mod が `next(e)` で権限の判定に回し、通ったら Supervisor が Run A を `prepared` で作り、runId を返す。
2. 親 Claude が runId を prompt にして `Agent` を呼ぶ。auto mode では Mod の `tool.check` が許可する。Mod の `agent.spawn` が caller を照合して Worker A を bind し、Worker Roster に載せる。Worker A の Host Step 0 で Codex A が始まる。
3. Codex A が調査 B とテスト C を `bridge_delegate` で委譲する。Supervisor は Run B・C を用意して応答を保留し、Worker A の Host Step が Permit 付きの `Agent` を返す。bind の直後に、保留中の呼び出しへ `accepted` を返す。
4. Codex A が `bridge_wait` を呼ぶ。Worker A は Bell を起動し、text で Worker の turn を終える（Yield）。
5. Codex B が再現確認 D を委譲する。D は深さ 3 なので、Codex D には子に関わる tool を出さない。
6. Codex B が D を待つ間に、Codex A が期限付きの `bridge_wait` で `pending` を受け取り、追加の調査 E を委譲する。Supervisor は Bell を鳴らして Worker A を起こし、E を bind する。Worker A は Bell を起動し直して再び Yield する。
7. D が終わり、Worker D が receipt を Report する。Supervisor は D の Worker の turn の終わりを見てから、Codex B の `bridge_wait` に D の結果を返す。B がまとめ、C・E も終わる。
8. Codex A が B・C・E の結果を `bridge_wait` で受け取り、Codex Turn を終える。子と Bell の完了通知がすべて会話に入った後の Worker A の turn で、Worker A が Report を一度だけ出す（manual mode は text、auto mode は `SubagentHandback`）。最上位の Report だけがメイン Claude へ届く。詳細ログは UI と成果物に残る。

### 18.2 モデルの変更

ユーザーが Run A の次の Codex Turn のモデルを変更する。`expectedRevision` を確認して予約設定を保存する。実行中の Codex Turn は変更しない。B/C/D の設定は起動時のままである。次の A の `turn/start` で新しい model と effort を明示して渡し、その Codex Turn の開始時の `thread/settings/updated` を `observed` に記録する。

### 18.3 親の停止と競合する子起動

ユーザーが A を停止する。同時に B が新しい子を要求しても、A の subtree の admission が閉じているため拒否する。既に受理済みの子は停止対象に入る。`prepared` のまま残っていた子の Run は `cancelled` にする。寝ている Worker は Bell で起こして停止を Report させる。停止途中の承認ボタンを押しても無効であり、新しい Codex Turn を起動しない。

### 18.4 reload で止まる Run

Run A・B が動いている間に、ユーザーが Mod を reload する。host が Supervisor を kill し、app-server は stdin の EOF で終わる。後で B の子が終わり、Worker B が完了通知で起こされると、新しい Mod の `turn.step` が新しい Supervisor に尋ね、`SUPERVISOR_RESTARTED` を受け取る。Worker B はそれを Report して終わる。同じプロンプトを自動で送り直さない。

### 18.5 Mod が Worker の turn を握れない場面

Mod の module が消えた後に、Worker A が子の完了通知で起こされる。型も消えていれば、Worker A は `general-purpose` として model で動き、Bash や `Agent` を呼ぶ。Guard は Worker Roster に A が載っていて Permit が無いので、全て拒否する。`SubagentHandback` も拒否され、呼び出し元には「報告なしで終わった」が届く。

## 19. 受け入れ試験

### 19.1 API 接続の検証ゲート

判定は Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）の prototype による。製品のコードで流し直すまでは、製品の合格とはみなさない。

| Gate | 実証すること | 判定 | 判定の内容 | 根拠 | 不成立の場合 |
|---|---|---|---|---|---|
| G01 | Mod が構造化ツールを登録し、schema が守られる | 条件付き | 登録 tool は schema 付きで渡り、`delegate` → `Agent` の 2 段で起動できる。engine は `inputSchema` を検証しないので、Bridge の検証器が守ることが条件。製品のコードでも、緩い `approvalPolicy` を勝手に足した `delegate` を `POLICY_DENIED` で止めた（#23） | [K04]、[K11] | 起動 API を提供しない |
| G02 | Worker の Host Step を Mod が処理し、通常経路で余計なモデル要求がない | 成立 | manual・auto とも Worker の Host Step はすべて `usage: null`。auto mode の Report（`SubagentHandback`）でも request は増えない。全ての handler がエラー文を返す実装が前提（`.catch` が無いと model に落ちる）。製品のコード（#23、stub の Codex）でも、manual・auto とも Worker の Host Step はすべて `usage: null` だった | [K02]、[K04]、[K10]、[K12]、[K13] | Native 統合を無効化 |
| G03 | 子の実際の parent ID が委譲元と一致する | 条件付き | 親の Worker が返す `Agent` の tool chunk で起こした子だけ、孫まで親が一致する。hook の `$.agent.spawn` では `parentAgentId: null` | [K02]、[K12] | R04 未達として配布を止める |
| G04 | Codex dynamic tool を広告し、呼び出しと応答が完結する | 条件付き | 応答を 15 分保留しても Codex Turn は続く。保留中も model が約 30 秒ごとに poll し、取り消しの通知は無い。`--listen unix://` でだけ送り直しがある | [K03]、[K04] | 再帰機能を利用可能と表示しない |
| G05 | 子→孫でも同じ経路が動き、ホストの上限を守る | 成立 | 孫まで同じ経路で bind し、caller の検問も効く。深さ 3 の agent には `Agent` が渡らない。Bridge は深さ 3 で委譲の tool を出さない | [K12] | ネスト対応と表示しない |
| G06 | Supervisor の spawn・Unix socket の HTTP・親の消失と異常終了時の停止が動く | 紙の上 | spawn、socket の HTTP、中継の SIGKILL で app-server が終わることは確かめた。製品の Supervisor で、Claude Code の SIGKILL から親の消失を検出して終わることも確かめた（#21）。app-server を持った状態での停止は試していない | [K04]、ADR 0001 | 対象 OS を非対応にする |
| G07 | Pane と agent view の状態が混線せず更新される | 紙の上 | 試していない | — | 実証できた表示面だけ対応とする |
| G08 | host の最終報告と dynamic wait の経路を区別できる | 条件付き | Codex の親には `bridge_wait` の応答だけで結果が届き、子の Report は親の Worker の会話に入るだけ。親の Worker が Yield し、子と Bell の完了通知を受け取ってから Report することが条件 | [K13]、[K14] | 二重配送のない代替契約を再設計するまで止める |
| G09 | モデル設定が実際の Codex Turn へ渡り、表示と整合する | 条件付き | 毎回の `turn/start` で明示し、開始時の `thread/settings/updated` と `model/rerouted` を `observed` にすれば整合する。provider が実際に使った model と effort の読み替えは見えない | [K17] | その設定の変更機能を無効化 |
| G10 | 管理外の委譲・権限の扱いが設定どおりに制御される | 条件付き | 委譲の tool は model に渡らず、呼ばれても `unsupported call`。reviewer は起動引数では止まらないので、Bridge が `user` を送り続け、起動直後の確認と tripwire を置くことが条件 | [K06]、[K09] | 厳密管理モードを提供しない |

公開型だけでは G02〜G08 の組み合わせ全体は証明できない。これらは mock だけで合格にしない。

### 19.2 機能・障害試験

| Test | 試験内容 | 成功条件 |
|---|---|---|
| T01 | model に似た行を含む本文 | 本文が設定として解釈されない |
| T02 | 異なるモデル・cwd で同時起動 | 設定が混ざらない |
| T03 | 非対応の effort | 実行前に理由付きで拒否 |
| T04 | A→B→D と A→C | 全 Run の論理親と native 親が一致 |
| T05 | 深さ 3 の Run と、深さ 3 の Claude の subagent の `delegate` | 委譲の tool が無い / `DEPTH_EXCEEDED`。副作用を起こさない |
| T06 | 読み取り専用の親から書き込み子 | grant がなければ拒否 |
| T07 | 親待機で生成枠が埋まる | 子が進む、または即時の容量エラー。無期限に詰まらない |
| T08 | 同じ本文を二度送る | 独立した二つの入力として配送 |
| T09 | 同じ operation を再試行 | 同じ Run を返し、子が増えない |
| T10 | 同じキーで違う payload | conflict を返す |
| T11 | `Agent` を呼んだ後に bind を確認できない | 二つ目の Worker を起動しない |
| T12 | `turn/start` の直後に app-server が終わる | Run を `failed` にし、自動で送り直さない |
| T13 | 子の完了前に親が final を返す | 子を回収し、最大一回の統合の Codex Turn を行う |
| T14 | 子が失敗する | 失敗が親の構造化結果から消えない |
| T15 | 親の停止と子起動が競合 | admission が閉じ、新たな孤児を作らない |
| T16 | 承認待ち中に reload | 前の承認は使えず、新しい Codex Turn を起動しない |
| T17 | 別 Agent の承認 ID を入力 | 対象・主体の不一致で拒否 |
| T18 | コマンド delta と完了出力 | 出力を重複連結しない |
| T19 | Codex Turn 中断、item 完了通知なし | 項目が永久に running にならない |
| T20 | 履歴再生・画面再描画 | provider / shell / spawn の呼び出し数がゼロ |
| T21 | 全 view を閉じて開き直す | 状態を復元し、仕事を再送しない |
| T22 | Mod の reload | 実行を二重起動しない。前の Run の Worker に `SUPERVISOR_RESTARTED` を返す |
| T23 | Claude Code が強制終了する | Supervisor が親の消失を検出し、app-server の process group を止める |
| T24 | 未 commit の変更をレビュー | 子が実際に対象 snapshot を読んでいる |
| T25 | 同じ作業領域への並列書き込み | 隔離または排他的所有権が働く |
| T26 | root の結果配送 | 自動経路で本文が二重に入らない |
| T27 | 大量のログと slow UI | 上限内で動き、欠落・省略を表示する |
| T28 | 未知の RPC request | 成功や許可へ変換せず明示エラー |
| T29 | 認証切れ | 秘密を表示せず、再認証が必要と分かる |
| T30 | 別の app-server の同じ request id、送り直しの同じ `callId` | 別 Run の結果を混同せず、同じ呼び出しは `callId` で突き合わせる |
| T31 | 選べる各 model で `bridge_wait` を長く保留する | poll の間隔が `yield_time_ms` の指示に従う。従わない model を記録する |
| T32 | Mod の module が消えた後に起こされた Worker（manual・auto） | Guard が Bash・`Agent`・`SubagentHandback` を拒否する |
| T33 | auto mode で、Permit 付きの `SubagentHandback` に Guard が `allow` を返す場合と、判定を返さない場合 | 届く方を採り、Report が注記付きで一回届く |
| T34 | Guard の script が無い | Worker Roster の agent の呼び出しは拒否され、main は止まらない |
| T35 | auto mode の 2 段目の `Agent` | 正しい runId は `tool.check` で通る。偽・使用済み・別 caller の runId は deny |
| T36 | 寝ている親に新しい `bridge_delegate`（manual・auto） | Bell で起き、bind して応答する。allow rule は要らない |
| T37 | 子と Bell の完了通知の前後の Report（manual・auto） | Report は一回だけ届き、途中経過の通知は呼び出し元に届かない |
| T38 | 深さ 3 の Run の `thread/start` | `dynamicTools` に子に関わる tool が無い |
| T39 | `thread/start` の応答の `approvalsReviewer` が `user` でない / `item/autoApprovalReview/started` が出る | Run を始めない / Run を止める |
| T40 | 未知の model、catalog に無い effort、`ultra` | 実行前に拒否し、thread に保存されない |
| T41 | `delegate` が host の判定で拒否される（manual・auto） | Run を作らない |
| T42 | reload の後、前の instance の Worker を `TaskStop` する | 止められるかを記録する。止められなくても Guard で何もできない |
| T43 | Report を出す時点の permission mode | Worker の起動時の mode で、manual は text、auto は `SubagentHandback` を選ぶ。途中で mode が変わった場合を記録する（8.4） |
| T44 | Yield した Worker と host の同時実行の上限 | Yield した Worker が枠に数えられるかを記録し、9.2 の値を見直す |

### 19.3 要件への追跡

| 要件 | 主な節 | 主な試験 |
|---|---|---|
| R01 / R02 | 5・7・12 | G01・G02・G09、T01〜T03・T40・T41 |
| R03 / R04 | 7・8 | G03〜G05、T04・T05・T35・T36・T38 |
| R05 / R11 | 6・13 | G07、T18〜T21・T26 |
| R06 | 4・14 | T08・T12・T22 |
| R07 / R08 | 10・11 | G10、T06・T16・T17・T25・T39 |
| R09 | 9・15 | G06、T07・T15・T23・T31・T44 |
| R10 | 13・14 | T09〜T12・T20・T22 |
| R12 | 2・17・19 | 全 Gate の対象版別記録 |
| R13 | 7.1・10.3・10.4 | T32〜T34・T42 |

## 20. 実装順序と公開条件

**段階 A：契約と骨組み。** 入力 schema と検証器、Supervisor の状態機械（`bun test` で Claude Code なしに試す）、Mod の登録 tool と Worker 型、Supervisor の起動と Unix socket の HTTP を作る。Guard、Worker Roster、Permit もここで作る。Worker は最初から `Agent` と Bash を持つので、守りを後回しにしない。

**段階 B：再帰経路を先に実証する。** 画面を作り込む前に、`delegate` → `Agent` → bind → Codex、`bridge_delegate` → 子、`bridge_wait` と Yield と Bell、Report を manual mode と auto mode で動かす。深さ 3 の扱いも含める。ここで製品のコードで G01〜G05、G08〜G10 を流し直し、T31〜T38 を確かめる。成立しなければ、見た目だけで完了としない。

**段階 C：構造化表示と設定 UI。** 公式イベントの fixture から Command、File change、Delegate、Approval を描く。snapshot / delta の整合をテストし、model と effort の選択と `configure` を実行契約へ接続する。

**段階 D：障害処理と権限。** 停止の伝播、承認の UI、作業領域、予算、出力上限を完成させる。

**段階 E：対象版を固定して配布。** G06・G07、障害試験、macOS での process の停止を実行し、対応 manifest を作る。未検証項目を supported として出荷しない。

初期版は単一 provider・ローカル・少数並列に留める。リモート実行、別 provider の統合、reload をまたぐ常駐、多ユーザー管理を先に作らない。

## 21. 設計判断の記録

| 判断 | 採用 | 採らない理由・注意点 |
|---|---|---|
| 状態の所有 | Mod の寿命に従う Supervisor（memory） | 切り離した Supervisor と SQLite は、reload をまたぐ利点を初期版で使わない（ADR 0001） |
| Codex 接続 | Run ごとの app-server を stdio | app-server の socket は WebSocket しか話さない。一つの app-server では Run の子 process を確実に止められない |
| 設定の入口 | schema 付きツールと UI。検証は Supervisor の contracts の検証器 | engine も app-server も検証しない。hooks module は plugin の外の contracts を import できない |
| ネイティブ統合 | 呼び出し元の loop の `Agent` と、`agent.spawn` での bind | hook の `$.agent.spawn` は親が付かず、auto mode では拒否される |
| 起床 | Yield と Bell | `$.session.send` は Mod の hook を外す。断ると Codex が作業を諦める |
| 報告 | 条件を満たした後に一度だけ。Worker の起動時の mode が manual なら text、auto なら `SubagentHandback` | 子の完了通知の前の stop と、Bell だけが生きている stop は、正しく届かない。Report の時点の mode は host が見ない（T43） |
| `SubagentHandback` の Guard | Permit を確かめて判定を返さない（`none`） | `allow` は host に捨てられ、結果は同じ（T33） |
| 守り | plugin の `hooks.json` の Guard と Permit | `AgentSpec.hooks` と Mod の hook は、Mod が居ない場面で効かない |
| 権限の審査 | `delegate` を host の判定に回し、段取りは Mod と Guard が許可する | ユーザーの `Agent(...)` の allow rule は auto mode で捨てられる |
| Codex 自身の委譲 | 専用 `CODEX_HOME`、起動引数、reviewer の固定、起動直後の確認、tripwire | 起動引数だけでは reviewer が止まらない |
| model 設定 | 毎回の `turn/start` で明示し、`observed` は開始時の thread の設定 | Codex Turn ごとの値を返す API は無い |
| Tool 表示 | 外部イベントから専用カード | 表示のために実行用 Tool を再投入しない |
| 作業領域 | 読み取り共有・書き込み隔離が既定 | ファイル名の担当宣言だけで衝突を防がない |
| 認証 | 専用 `CODEX_HOME` でユーザーが一度 login | Bridge は認証ファイルに触れない |

### 決めていないこと・確かめていないこと

実装の ticket に切り出すときは、次を各 ticket の中で決めるか、試験で確かめる。

| 事項 | 扱い |
|---|---|
| 選べる各 model が長い `wait` の指示に従うか | T31。従わない model を選べるままにするかは、その結果で決める |
| auto mode で起こした Worker の Report の前に manual mode へ切り替えた場合 | Report が届かない（8.4、T43）。初期版では制限として扱う |
| 子と Bell の完了通知が会話に入ったことの判定 | 本書は「子の Worker の turn と Bell の終わりの後に来た Host Step の境目」とみなす（8.3）。Host Step の入力に通知が見えるかは段階 B で確かめる |
| reload の後、前の instance の Worker を止められるか | T42。Guard があるので止められなくても何もできない |
| Yield した Worker が host の同時実行の枠に数えられるか | T44 |
| memory の上限 | 実装で決める。`preparedTtl` は 5 分（7.2）、state の directory の掃除の期間は 7 日に決めた（13.3） |
| 統合の Codex Turn（8.3） | 実機で確かめていない。段階 B で T13 を流す |
| shell から別の CLI を起動する経路（8.5） | Bridge だけでは止められない。初期版では制限として表示する |
| UI（6 章）、承認（10.5）、作業領域（11.1）、予算（9.4）、異常終了（15.3、G06） | 紙の上の設計。段階 C〜E で実装と試験を行う |
| Linux | 初期範囲外。G06 にあたる試験を通してから加える |

classifier が危険な `delegate` を止めるかは確かめない。classifier の一般的な振る舞いで、Bridge の設計では変えられない。Bridge が守るのは、中身を持つ呼び出しを審査に回すことまでである（[K15]）。

**本書の完成状態は設計であり、製品の動作保証ではない。** ただし、未確認点は単なる TODO ではなく、公開可否を決める Gate と試験、失敗時の挙動まで定義している。

## 22. 参照資料

### S — 公式の資料

参照日は 2026-10-23。

#### S01 — Claude Code Mods の公開型と実行環境

Claude Code 2.1.309 に同梱されている `plugin-authoring` skill と、その型宣言 `claude-code.d.ts`。runtime の制約、`$.agent`、`$.tool`、`$.process`、`$.http`、`$.state`、`$.store`、`turn.step`、`agent.spawn`、`tool.check` を参照した。v1 は公式リポジトリの 2.1.277 の宣言を参照していた。

#### S04 — Claude Code の子からの再委譲と制限

Anthropic 公式ドキュメント「Create custom subagents」の “Let subagents spawn their own subagents” と “Concurrent subagent limit”。

[公式 Subagents ガイド](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)

#### S05 — turn.step の応答と tool chunk

S01 の型宣言の `TurnStepInput`、`TurnStepChunk`、`TurnStepToolChunk`。

#### S06 — 描画契約

S01 の型宣言の `RenderPropsOf`。`AssistantMessage`、`ToolUse`、`ToolResult`、`Pane` の責任境界。

#### S07 — Codex App Server

OpenAI 公式ドキュメントと、codex-cli 0.163.0 の `codex app-server generate-ts --experimental` の生成物。dynamic tool は実験的 API である。

[公式 App Server ドキュメント](https://learn.chatgpt.com/docs/app-server)

#### S08 — Codex の TurnStartParams

S07 の生成物の `TurnStartParams`。model / effort / cwd / sandboxPolicy / approvalsReviewer。

#### S09 — Codex の実行項目

S07 の生成物の `ThreadItem`。commandExecution、fileChange、mcpToolCall、dynamicToolCall、collabAgentToolCall。

#### S10 — Codex の Subagents

OpenAI 公式ドキュメント。Codex 自体の Subagent と、本製品が管理する委譲との区別に使用。

[公式 Subagents ガイド](https://learn.chatgpt.com/docs/agent-configuration/subagents)

#### S12 — Bun の child process API

Bun 公式ドキュメント。引数配列による起動、pipe への継続書き込み、出力 stream、終了操作。

[公式 Spawn ドキュメント](https://bun.sh/docs/runtime/child-process)

v1 の S02・S03・S11 は S01 にまとめた。S13（Bun の SQLite）は、初期版が SQLite を持たないので外した。

### K — 実機で判定した ticket

map「[Codex Bridge 設計書 v1 の実現可能性を確かめ、v2 設計書へ](https://github.com/ashigirl96/dawpi/issues/1)」の子 ticket。各 ticket の解決 comment に、prototype の branch と生のログへのリンクがある。

| 番号 | ticket |
|---|---|
| K02 | [Mod が spawn した子の親 ID は、spawn を呼んだ agent になるか](https://github.com/ashigirl96/dawpi/issues/2) |
| K03 | [Codex の dynamic tool 呼び出しを保留したまま、後から応答して turn を続けられるか](https://github.com/ashigirl96/dawpi/issues/3) |
| K04 | [Mod から codex app-server と双方向の JSON-RPC で話せるか](https://github.com/ashigirl96/dawpi/issues/4) |
| K05 | [Claude Code の subagent の上限と hook の予算は、Mod の spawn と待ちにどう効くか](https://github.com/ashigirl96/dawpi/issues/5) |
| K06 | [Codex 自身の委譲を止め、個人の AGENTS.md を読ませずに起動する方法](https://github.com/ashigirl96/dawpi/issues/6) |
| K07 | [Supervisor を Mod の中に置くか、切り離した process にするか](https://github.com/ashigirl96/dawpi/issues/7) |
| K08 | [Bridge 専用の CODEX_HOME を作り、ChatGPT で login する](https://github.com/ashigirl96/dawpi/issues/8) |
| K09 | [Bridge の起動設定で実際の Codex Turn を流しても、Codex 自身の委譲が起きないか](https://github.com/ashigirl96/dawpi/issues/9) |
| K10 | [auto mode で、Mod の worker は SubagentHandback で結果を届けられるか](https://github.com/ashigirl96/dawpi/issues/10) |
| K11 | [auto mode で、Run の最上位の worker をどう起動するか](https://github.com/ashigirl96/dawpi/issues/11) |
| K12 | [Codex の保留中の bridge_delegate を、親 worker の Agent 呼び出しにつなぎ、孫まで委譲できるか](https://github.com/ashigirl96/dawpi/issues/12) |
| K13 | [子の Run の結果を、親の Codex には保留中の bridge_wait だけで返せるか](https://github.com/ashigirl96/dawpi/issues/13) |
| K14 | [bridge_wait を保留して寝ている親 worker を、Codex の新しい bridge_delegate のために起こせるか](https://github.com/ashigirl96/dawpi/issues/14) |
| K15 | [auto mode で、最上位の worker の起動と呼び鈴の Bash は、classifier と allow rule にどう判定されるか](https://github.com/ashigirl96/dawpi/issues/15) |
| K16 | [Mod が turn を握れない場面で、worker の定義だけで Bash と Agent を止められるか](https://github.com/ashigirl96/dawpi/issues/16) |
| K17 | [Run に指定した model と effort が実際の Codex Turn に届いたことを、どの観測値で確かめ、thread と turn のどちらで渡すか](https://github.com/ashigirl96/dawpi/issues/17) |

ADR: `docs/adr/0001-supervisor-lives-with-the-mod.md`（Supervisor は Mod の寿命に従い、reload で Run を止める）。

---

**実装者への最重要条件:** UI の刷新より先に、正しい親ループからの子起動、Guard による守り、構造化された設定の適用、Report と `bridge_wait` の一経路配送を証明する。設定と本文、実行と表示、権限とモデルの判断を同じ文字列へ戻さない。
