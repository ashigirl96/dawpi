# Claude Code × Codex Bridge — 新規設計書

**版:** 1.0（設計案）  
**作成日:** 2026-10-23 JST  
**対象:** ローカルの Claude Code に、モデルを選択できる Codex エージェント群を統合する新規プラグイン  
**実装識別子:** `codex_bridge`（本書内の仮称）  
**検証状態:** 公式ドキュメント・公開型宣言の調査まで。実装、型検査、実機接続試験は未実施。

> **設計の要点**  
> Claude Code は対話とネイティブ Agent のホスト、Codex は推論と作業の実行基盤、Bridge は委譲の管理者とする。タスク本文、実行設定、権限、実行履歴を独立させる。親も子も同じ構造化 API を使い、再帰的な委譲を管理する。表示は実行履歴から作り、表示のための再実行はしない。

## 1. 目的と完成条件

### 1.1 実現する体験

ユーザーは Claude Code で「認証の実装を Codex にレビューさせる」と依頼できる。親 Claude はタスク、モデル、推論強度、作業領域、権限を構造化して指定する。起動された Codex は、必要なら別の Codex に調査を委譲し、その子もさらに委譲できる。ユーザーは各エージェントの実行状況、コマンド出力、ファイル差分、質問を Claude Code 内で確認できる。

```text
Claude のメイン会話
└─ Codex：レビューの取りまとめ
   ├─ Codex：認証フローの調査
   │  └─ Codex：指摘事項の再現確認
   └─ Codex：テストの確認
```

モデル ID、推論強度、sandbox はプロンプト文法にしない。依頼欄には依頼だけを記述する。例えば `model: ...` で始まる文章であっても、タスク本文を設定として解釈しない。

### 1.2 要件

| ID | 要件 | 完成の判定 |
|---|---|---|
| R01 | Claude から Codex を起動できる | 型付き入力を受理し、実際の Codex の結果が返る |
| R02 | モデル・effort・作業領域を独立指定できる | 本文を解析せず設定され、実行時の値を確認できる |
| R03 | Codex から Codex へ再帰委譲できる | 親→子→孫が同じ公開契約を使って実行される |
| R04 | ネイティブの親子関係を保持する | Claude Code が保持する親 ID が実際の委譲元と一致する |
| R05 | Tool の構造化表示がある | 入力、状態、出力、終了コード、差分を展開できる |
| R06 | 実行中・完了後に追加依頼できる | 実行中への追加入力と、完了後の会話再利用が区別される |
| R07 | 承認の対象と主体を特定できる | 普通のチャット発言を承認として扱わない |
| R08 | 親から子へ権限が増幅しない | 許可範囲を超える子の起動・設定変更を実行前に拒否する |
| R09 | 並列実行と停止を管理できる | 上限が守られ、親の停止が子孫へ伝わる |
| R10 | 切断・再読み込みで二重実行しない | 配送が不明な操作を照合せず再送しない |
| R11 | UI と親モデルへの報告を分離する | 詳細ログが親モデルのコンテキストへ無条件に入らない |
| R12 | 互換性を確認して起動する | 対象バイナリと API 契約の試験結果を記録する |

**R04 は単にツリー状に描くことではない。** 独自画面での論理ツリーと Claude Code 自身の親子関係を別々に検証する。ネイティブ統合が未検証のビルドを、完成した統合版として配布しない。

### 1.3 初期リリースの範囲

macOS / Linux のローカル利用、単一ユーザー、ローカル Codex CLI、Claude Code の対話 UI を対象とする。コードは TypeScript、Supervisor は Bun 上で動作する構成を採用する。Windows、クラウド常駐、複数ユーザー、任意の LLM provider への汎用化は初期範囲外とする。

headless では同じ制御契約と構造化結果を提供するが、GUI の承認を要求する設定を自動許可へ切り替えない。外部の明示的な承認接続がなければ、承認待ちを期限付きで終了する。

## 2. 公式 API と設計上の区別

本書の **「確認済み」** は公開資料上の存在を指す。対象端末で動作したという意味ではない。**「採用仕様」** は本製品の設計判断、**「検証ゲート」** は対応版を公開するために必要な実機試験を指す。

| 論点 | 公開資料上の事実 | 本設計への意味 |
|---|---|---|
| Mods の実行環境 | 公開型は Node / DOM のない環境を記述している [S01] | 子プロセス・永続 DB を扱うコードを Mod 内に直接持ち込まない |
| ツール登録 | `$.tool.register` は JSON Schema を持つプラグインツールを登録する [S02] | モデル指定を専用ツールの引数にできる |
| Agent 起動 | `$.agent.register` / `$.agent.spawn` がある。`parentAgentId` はホストが決める項目 [S03] | 親 ID の書き換えではなく、正しい親ループから起動する |
| ネイティブ再帰 | Claude Code の公式ガイドには子からの再委譲と深さ制限がある [S04] | 本製品の制限とホスト側の制限の両方を守る |
| モデル応答の接続 | `turn.step` は応答を供給でき、tool chunk は実行の意味を持つ [S05] | 外部実行ログと、これから実行する制御呼び出しを混同しない |
| UI | `ToolUse` / `ToolResult` / `AssistantMessage` の描画契約がある [S06] | 描画フックの存在だけで、任意の外部 Tool 行を挿入できるとは仮定しない |
| Codex 接続 | app-server は双方向 RPC と実行イベントを提供する [S07] | ログを解析する CLI ラッパーでなく、プロトコル接続を使う |
| 子起動ツール | `dynamicTools` と `item/tool/call` は実験的機能 [S07] | 再帰委譲に使うが、対応版を固定して検証する |
| 実行設定 | Codex の `turn/start` に model / effort / cwd / sandboxPolicy がある [S08] | 本製品の設定を型付き RPC 引数へ変換する |
| 実行項目 | command / file change / MCP / dynamic tool は別の構造化型 [S09] | 最初から項目別のデータと描画を設ける |

確認した Anthropic 公開型の冒頭は **Claude Code 2.1.277 が生成した宣言**と記載している。これは利用者の最新バイナリの契約を保証しない。実装時には対象版の `/plugin-types` を生成し、ホスト試験と一緒に保存する。Codex も対象 CLI から生成したスキーマを用い、実験的なフィールドを通常生成物が含むとは決めつけない。[S01][S07]

本書の `delegate`、`configure`、`dispatch_control`、`RunSpec` 等は**新しく実装する本製品の契約**であり、Claude Code / Codex の組み込み API 名ではない。

## 3. 基本構成

### 3.1 三つの責任を分ける

```text
┌──────────────────────────────────────────────────────┐
│ Claude Code                                          │
│  メイン Claude / ネイティブ Subagent / 対話 UI        │
│                         │                            │
│  Bridge Mod             │                            │
│  ・型付きツール         ・ネイティブ Agent 接続       │
│  ・モデル設定 UI        ・実行タイムライン             │
└─────────────────────┬────────────────────────────────┘
                      │ 認証付きローカル RPC
                      │ Unix domain socket
┌─────────────────────▼────────────────────────────────┐
│ Session Supervisor（1 Claude セッションにつき1個）    │
│  ・Run 台帳 / 設定 / 権限 / 親子関係                 │
│  ・起動操作 / 配送 / 結果回収 / 停止 / 復旧           │
│  ・Codex RPC 接続 / 出力保存 / UI 用の状態             │
│                         │                            │
│  SQLite + 出力ファイル  ├─ app-server：Run A          │
│                         ├─ app-server：Run B          │
│                         └─ app-server：Run C          │
└──────────────────────────────────────────────────────┘
```

**Mod はホスト接続と画面、Supervisor は実行管理、Codex は実作業を所有する。**

Supervisor は全ユーザー共通の常駐 daemon ではない。Claude セッションに所有される補助プロセスであり、ホストとの lease が失われれば実行を止める。UI が閉じただけでは実行を止めないが、セッション終了は別の操作として扱う。

### 3.2 この構成を採用する理由

実行を UI の描画コールバックや一つの長時間 hook に所有させると、描画の再実行、hot reload、view 切り替えと実行の寿命が結び付く。そこで、親子関係、RPC 待ち、承認待ち、プロセスは Supervisor に集め、Mod は何度接続し直しても同じ状態を取得できるようにする。

一方、ネイティブ Agent の生成はホストの責任なので、Supervisor から親 ID を偽装して直接作ろうとはしない。Supervisor が発行した制御要求を、対応するネイティブ親ループに戻して実行する。

プロセス境界はライフサイクルと障害処理のためであり、それ自体をセキュリティ sandbox とは呼ばない。

### 3.3 状態の正本

| 情報 | 正本 |
|---|---|
| 論理的な親子関係・予算・操作の受理 | Supervisor の DB |
| Codex 内の会話と実行結果 | Codex の thread / turn / item |
| Claude Code の Agent ID と実際の親 ID | Claude Code |
| 現在表示しているタブ・折り畳み | Mod の UI 状態 |
| 呼び出し可能なモデル | 利用アカウント・provider に対する Codex のモデル一覧 |
| 実行能力の上限 | 管理ポリシー、ユーザーの grant、Codex/OS の制約 |

表示上のラベル、プロンプト内の文字列、モデルの自己申告を正本にしない。対応関係の不整合はログで隠さず `recovery_required` として扱う。

## 4. データモデル

### 4.1 会話と仕事を分ける

**Conversation** は再利用可能な Codex の会話。**Run** は一回の委譲された仕事。**Turn** はその仕事中の一回の Codex ターンである。

一つの Run は複数の Turn を含める。例えば追加指示や、子の結果を受けた最終統合が該当する。ただし、完了済み Run を再び running に戻さない。完了後の追加依頼は、新しい Run を作り、許可された場合に同じ Conversation を再利用する。

これにより、過去の完了報告や親子関係が後から変わらない。UI では Conversation ごとに履歴をまとめられるが、仕事の履歴は別々に残す。初期版のネイティブ Agent は Run ごとに作成する。

```ts
// 本製品で新しく定義する概念型。公式 SDK の型ではない。
type Run = {
  id: string;
  hostSessionId: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;                 // root = 1
  conversationId: string;
  predecessorRunId?: string;     // 完了後の追加依頼でのみ設定
  nativeAgentId?: string;
  specRevision: number;
  status: RunStatus;
  ownerEpoch: number;
  resultId?: string;
};

type RunStatus =
  | "admitted" | "binding" | "starting" | "running"
  | "waiting_children" | "waiting_user" | "finalizing"
  | "cancelling" | "completed" | "failed" | "cancelled"
  | "recovery_required";
```

`parentRunId`、`rootRunId`、`depth` はモデル入力に含めず、認証された呼び出し元から計算する。同じ Conversation に二つの非終端 Run を同時接続しない。

### 4.2 ID と対応付け

| ID | 発行主体 | 用途 |
|---|---|---|
| `runId` | Supervisor | 委譲された仕事の識別 |
| `operationId` | Supervisor | 起動・設定変更等の冪等な操作 |
| `messageId` | 入力 adapter | 一回のメッセージ配送 |
| `nativeAgentId` | Claude Code | ホスト側の Agent 識別 |
| `threadId` / `turnId` / `itemId` | Codex | provider 側の実行識別 |
| `connectionEpoch` | Supervisor | 再接続前後の要求を区別 |
| `approvalId` | Supervisor | 許可要求を特定 |
| `resultId` | Supervisor | 不変の結果と配送重複の識別 |

同じ文字列を二度入力した場合は、二つの `messageId` である。本文の一致を理由に重複削除しない。

## 5. 公開 API とモデル設定

### 5.1 一つの契約を複数の入口で使う

Claude からは Mods の登録ツール、Codex からは dynamic tool、人間からは設定パネルを使う。三つの入口は同じ検証器・同じ Supervisor の操作に到達する。

| 論理操作 | Claude 側の登録ツール例 | Codex 側の dynamic tool 例 |
|---|---|---|
| 子の委譲 | `mcp__codex_bridge__delegate` | `bridge_delegate` |
| 状態取得 | `mcp__codex_bridge__inspect` | `bridge_inspect` |
| 結果を待つ | `mcp__codex_bridge__wait` | `bridge_wait` |
| 追加指示 | `mcp__codex_bridge__send` | `bridge_send` |
| 設定変更 | `mcp__codex_bridge__configure` | `bridge_configure` |
| 停止 | `mcp__codex_bridge__cancel` | `bridge_cancel` |

通常のモデルに承認権限を渡す `approve` ツールは登録しない。ユーザー本人の承認は別の UI 操作として扱う。

ツールは所属する Run の直下の子を操作できる。兄弟、祖先、別ツリーの Run を操作する権限は既定では与えない。ユーザーの管理 UI は本人に許可されたツリー全体を扱える。

### 5.2 起動入力

以下は本製品に実装する入力の例である。モデル ID は例示であり、実際に利用できるかは接続先のカタログで検証する。

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

初期版のモデル公開 schema では、未知のプロパティを拒否する。任意の環境変数、任意の CLI フラグ、認証ファイルの場所、任意の `config` オブジェクトはモデルから受け付けない。これらが必要な場合はユーザー管理の profile を選択する。

### 5.3 モデル一覧と effort

Codex の `model/list` をページ末尾まで取得し、provider・認証コンテキスト別にキャッシュする。UI のモデル選択後に、そのモデルに対応する effort の選択肢を表示する。モデルの能力一覧をコードへ固定しない。[S07]

カタログを取得できない場合はキャッシュの更新日時を表示する。モデルの削除、権限不足、対応しない effort は、別の値への黙った置換ではなく検証エラーにする。未知のモデル ID を許す高度なユーザー操作を設ける場合も、実行開始前の検証結果を表示する。

### 5.4 設定の解決

通常の値の優先順は、**呼び出し時の指定 → 選択した profile → 起動時点の親の有効設定 → ユーザーの既定値 → provider の既定値**とする。

この優先順は権限の上書き順ではない。どの指定であっても、管理ポリシーと委譲の上限を超えられない。指定値が上限に反する場合は拒否し、理由と許可された範囲を返す。黙って設定を縮小して「要求どおり実行した」とは見せない。

保存する設定は次の三種類とする。

| 種類 | 意味 |
|---|---|
| `requested` | 入力が明示した値 |
| `resolved` | 既定値を補い、制約検証を通した値 |
| `observed` | Codex の応答や実行状態から確認できた値 |

確認できない `observed` フィールドは unknown と表示する。要求した値を実績へコピーしない。子には親の設定の**起動時点のスナップショット**を渡し、後の親の変更を勝手に伝播させない。

### 5.5 実行中の設定変更

`configure` は `expectedRevision` と patch を受け、競合した編集を検出する。model / effort は次の Codex ターンから反映する。`turn/steer` は追加入力であり設定変更の経路ではない。[S07][S08]

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

sandbox の拡大、書き込み先の追加、ネットワーク権限の増加は一般設定と分離する。進行中のターンへ混ぜず、ユーザーの grant を更新し、必要なら停止・再設定する。`cwd` と作業領域の入れ替えは初期版では同一 Run 中に許さず、新しい Run とする。


### 5.6 操作ごとの返答と期限

| 操作 | 必須となる主な入力 | 返答・効果 |
|---|---|---|
| `delegate` | task、必要な設定 | `operationId` / `runId` / `accepted`。外部実行の完了とは別 |
| `inspect` | runId | 状態、設定 revision、子の一覧、結果の参照。読み取りのみ |
| `wait` | runIds、all または any、timeout | 終端した子の結果と pending の一覧。再実行しない |
| `send` | runId、text、配送方針 | messageId と queued / accepted。応答文の生成完了は待たない |
| `configure` | runId、expectedRevision、patch | 新しい revision と適用時点、または conflict |
| `cancel` | runId、reason | 停止操作の receipt。停止確認前は cancelling |

配送方針は `next-turn` を既定とし、明示した `active-turn` の場合だけ進行中ターンへの steer を試みる。既に turn が終わっていた場合、provider が明示的に未受理を返せば次ターンへ queue できる。通信失敗で受理状況が不明な場合は自動的に別ターンへ送らない。

内部 transport の再試行キーは adapter が入力の同一性から作る。モデルが任意の caller や偽の接続識別子を指定するフィールドは存在しない。`wait` の提案上限は一回 30 秒とし、ホストの tool 待機時間がそれより短ければさらに下げる。期限後に返る pending は、子を再起動する理由にしない。

## 6. UI と操作体系

### 6.1 主画面

Claude Code のネイティブ Agent 一覧を保ち、Bridge の詳細画面には次を配置する。

| 領域 | 内容 |
|---|---|
| Run ツリー | 親・子・孫、状態、モデル、未解決の承認数 |
| 設定バー | 実行中の設定と次ターンの予約設定、cwd、制限 |
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
| Usage | 自身の消費、子孫を含む消費 | 入力、キャッシュ、出力、計測範囲 |

Codex の出力が stdout と stderr を集約している場合、UI も「出力」として表示する。分離されていない情報を別ストリームとして捏造しない。`cat` や `rg` らしいコマンドであっても、元の実行を Claude の `Read` / `Grep` として偽装しない。[S09]

### 6.3 描画の接続

初期版で確実に所有できる詳細表示は、Mod が開く `Pane` のタイムラインとする。ネイティブ Agent の表示には要約と詳細への導線を用意する。対象版で安定した行 ID との対応付けを検証できれば、Agent view 内にも同じタイムライン部品を配置する。

**独自 Tool カードを描くことと、Claude Code 内部の ToolUse 記録を作ることは別である。** Codex が既に実行したコマンドを、Claude の実行用 `Bash` tool call として送り返さない。公式の描画 API だけで内部行を自由に生成できると仮定しない。[S05][S06]

### 6.4 実行と表示を分離する不変条件

`render(state)` は、外部プロセス起動、RPC 送信、権限変更を行わない。UI のボタンは描画と別の action handler を呼び、対象の revision と認証済みの操作主体を伴って Supervisor へ送る。

画面を開き直す、履歴を再生する、端末サイズを変更する、出力を展開する、といった操作によって仕事が再実行されてはならない。

## 7. Claude Code とのネイティブ統合

### 7.1 内部 worker を一種類だけ登録する

Mod は `codex_bridge:worker` を内部 Agent 型として登録する。モデルごと・権限ごとに Agent 型を増殖させない。ユーザーや親 Claude は公開の `delegate` ツールを使い、内部 worker の直接起動は原則として一覧に出さない。

worker の責務は、Codex の仕事をホストの Agent ライフサイクルへ接続することである。Codex のモデル名を Claude のモデル resolver に無条件で渡さない。ホスト上の登録用モデルと、実際の Codex モデルは別フィールドに保持する。

通常経路では、worker の `turn.step` を Mod が処理するため、中間の Claude 推論を必要としない。ただし、公開型には hook の失敗時に下位処理へ進む仕様があるため、**Mod が外れた場合まで追加の Claude API 呼び出しが絶対にないとは保証しない**。制御した例外は終端エラーに変換し、意図的なモデル fallback は行わない。予期しない host fallback は互換性試験と運用上のリスクとして記録する。[S01][S05]

### 7.2 起動は prepare → bind → activate

1. Supervisor が入力を検証し、権限・深さ・予算・重複を確認する。
2. `operationId` と `runId` を発行し、`admitted` と予約容量を DB に保存する。
3. Mod が委譲元のネイティブループ内で `$.agent.spawn` を実行する。
4. 得られた `nativeAgentId` を Run に紐付ける。実際の親 ID を照合する。
5. 紐付けが確定してから Codex の thread と turn を開始する。
6. 呼び出し元に受理結果を返す。完了を待たせない。

Agent の最初の hook が spawn の戻りより先に走る競合を考慮する。spawn 前に、予約済みの一意なネイティブ `name` と `runId` の対応を作る。worker の最初の step は、ホストが返す Agent 情報から対応を確認して CAS で bind する。予約と一致しない worker は実行しない。`name` は相関 ID であって、認証 token ではない。

この手順は対象版で次の二点を検証するまで有効化しない。第一に、生成された Agent 情報から name と親の対応を信頼できること。第二に、プラグイン自身による spawn が、必要な別の `turn.step` handler を飛ばさないことである。[S03][S05]

### 7.3 Codex からの子起動を、正しい親ループへ戻す

Codex 内からの `bridge_delegate` は app-server の server request として受ける。Supervisor がその要求をいきなり別の場所から spawn するのではなく、未実行の制御操作として待機させる。

```text
Codex A
  │ bridge_delegate(spec)
  ▼
Supervisor
  │ threadId から Run A を特定
  │ 操作を検証・保存し、control queue に置く
  ▼
A に接続された Mod の turn.step
  │ 実際に未実行の dispatch_control tool call を返す
  ▼
Claude Code の A の tool loop
  │ tool.call の agentId が A であることを検証
  │ $.agent.spawn(codex_bridge:worker)
  ▼
Native Agent B ↔ Run B ↔ Codex B
  │ bind / activate の結果
  ▼
A の保留中 dynamic tool request に回答
```

`dispatch_control` は本製品が内部登録するツールである。引数は保留操作の ID のみで、自由なコマンド文字列や任意の `parentRunId` は受け付けない。Supervisor の台帳、呼び出し元 Agent、接続 epoch が一致する場合にだけ実行する。名前が内部向けであることを認可の代わりにしない。

ここで返す tool call は、**未実行の子起動要求を実行するもの**である。既に Codex が終えた shell 操作の再現ではない。ホスト側の一つの model step と Codex の一つの turn を同一視せず、Codex が動作中でもホストの制御 step を進められるようにする。

### 7.4 保証する範囲と互換性モード

正式な Native モードは、子・孫の `parentAgentId`、停止、報告、hook の再入を実機で確認した組み合わせだけで有効にする。親 ID を上書きしたり、トップレベルに作った Agent を子に見えるよう名前で偽装したりしない。

開発・診断用には、Supervisor の論理ツリーを Pane にだけ表示する Managed-only モードを用意できる。ただしこれは R04 を満たさず、ユーザーが明示して使う別モードである。Native の失敗時に黙って切り替えない。

## 8. 再帰的な委譲の契約

### 8.1 同じ API をすべての深さで使う

最上位の Codex と子・孫に、同じ `delegate` / `inspect` / `wait` / `send` / `cancel` 契約を提供する。各起動で caller scope を自動的に狭める。

```ts
// 擬似コード：認可済みの caller は transport / host adapter が生成する。
async function delegate(caller: Caller, input: DelegateInput) {
  return admissionTransaction(() => {
    const parent = resolveCallerRun(caller);
    assertParentAcceptsChildren(parent);
    const resolved = resolveAndValidate(input, parent);
    assertWithinPolicy(resolved, parent);
    assertWithinCapacity(parent, resolved);
    return prepareRunAndHostOperation(parent, resolved);
  });
}
```

モデルに `caller` を入力させない。Codex では接続と thread の対応、Claude ではホストの tool event に含まれる Agent ID から決定する。

### 8.2 delegate は完了待ちしない

返答は `runId`、受理状態、適用された設定、状態確認の方法である。起動拒否や native bind の失敗は明示的なエラーとする。

親が子の完了を同じ `delegate` の中で待つ方式は採らない。親が複数の子を起動し、独立した `wait` で結果を集められるようにする。

`wait` は直下の子の Run ID、`mode: all | any`、期限を受け付ける。結果には終端済みと未完了を分けて返す。タイムアウトは `pending` であり、子の停止や失敗を意味しない。祖先待ち、自己待ち、権限のない別ツリー待ちを拒否する。

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

親の final message が来ても、子が生存していれば Run は完了しない。暫定回答を保存して `waiting_children` とし、子の終端後に一度だけ結果統合用の Turn を許可する。この統合 Turn では新規委譲を拒否する。子の失敗や未完了は統合結果に残す。統合にも失敗した場合は、暫定文を完成品として装わず incomplete を返す。

初期版では親が終了して子だけ無期限に動く detached delegation を提供しない。

### 8.4 報告経路は一つ選ぶ

| 呼び出し元 | 最終結果の主経路 |
|---|---|
| メイン Claude | ネイティブ Subagent の最終報告 |
| Codex の親 | `bridge_wait` の dynamic tool 応答 |
| 人間の UI | Supervisor の結果を直接参照 |
| headless の呼び出し元 | 認証済み control API の結果取得 |

子がホストにも返す完了通知は、必要最小限の receipt と `resultId` にする。Codex の親には、ホストの通知本文を会話履歴から拾って再投入しない。Codex が受け取る結果本文は `wait` 経路のみにする。

最上位の native delivery を使う Run に対する通常の `wait` は、完了状態と receipt を返す。結果本文を別経路で自動プッシュしない。ユーザーが明示的に結果を読み直す操作は許可する。

### 8.5 Codex 内部の Subagent との関係

Codex 自身にも Subagent の仕組みがあり、公開イベント型にも子 Agent の活動がある。[S09][S10] しかし、本製品が管理する委譲と同時に無制限利用させると、別の親子ツリー・予算・停止管理が生まれる。

初期版では管理対象の再帰は `bridge_delegate` に統一する。対象版で独自の組み込み委譲を無効化できるかを検証する。無効化できない場合、管理上限が Codex 内部の全委譲まで及ぶとは表示しない。その機能を許す構成は「外部委譲を含む制限付き管理」とし、厳密な再帰管理を必要とするモードでは起動を拒否する。

また、shell から別 CLI を直接起動する経路まで、Bridge の台帳だけで禁止できるわけではない。管理対象外の実行を含めた厳密な制限には、実行環境側の制約が必要である。

## 9. スケジューリングと予算

### 9.1 別々に数える資源

| 資源 | 待機中の親は消費するか |
|---|---|
| ネイティブ Agent のスロット | ホストの数え方に従う。勝手に解放したことにしない |
| app-server プロセスとメモリ | 消費する |
| 実行再開を許す Supervisor の枠 | 制御された子待ち・承認待ちでは解放可能 |
| ツリー全体の時間期限 | 待機中も進む |
| 生成済みノード数 | 終了後も累積値に含める |
| token 使用量 | 実際に provider が報告した分を加算する |

待機中の親から実行枠を戻すのは、Supervisor が dynamic tool 応答を保留しており、Codex の再開を制御できる場合に限る。子が終わった後は枠を再取得してから応答を返す。UI に「待機」と出ているだけで生成中の処理を枠の外にしない。

### 9.2 初期値

以下は製品の提案値であり、プロバイダーの制限や性能を示す値ではない。

| 設定 | 提案する初期値 |
|---|---|
| `maxDepth` | 3（root = 1。ホストの許容値以下に制限） |
| `maxChildrenPerRun` | 4 |
| `maxRunsPerTree` | 16（再試行・再起動による増殖も制限） |
| `maxGeneratingRuns` | 4 |
| `maxLiveRuntimeProcesses` | 8 |
| `treeDeadline` | 30 分。明示的に延長できる |
| `maxFinalizeTurns` | 1 |

`maxDepth` はホストの実際のネイティブ階層も計算して適用する。既に Claude の深い Subagent から起動した場合、root=1 という本製品内の数え方だけでホスト上限を回避しない。Claude Code 自体にも深さ・同時実行数の制限がある。[S04]

### 9.3 デッドロック回避

起動時点でホストスロットの確保ができない場合、親を無期限に保留するのではなく `CAPACITY_EXHAUSTED` を返す。親は自分で処理するか、既に起動した子を待ってから再度明示的に委譲する。

Supervisor の待機キューと、ネイティブ Agent 作成済みの待機を区別する。親が全ネイティブ枠を占有したまま、まだ Agent を作れない子を待つ循環を作らない。最初の実装では複雑な優先度継承より、保守的な admission と明示的な失敗を優先する。

### 9.4 費用と token

予算は root Run に集約し、子は残予算の一部を予約する。予約と解除をトランザクションで扱う。同じ provider usage snapshot を何度も足さず、turn ID と更新時点を用いて重複を防ぐ。

表示は「現在のコンテキスト」「その Run の累積消費」「子孫を含む累積消費」を分ける。キャッシュ入力が入力合計の内数かどうかを provider adapter で明示する。

金額換算は利用プラン・provider・価格表によって異なるため、初期版は取得できた token 実績を主指標とする。正確な価格が不明なら金額を表示しない。token 報告の遅延があるため、ローカル監視だけで請求額の厳密な上限を保証しない。

## 10. 権限と承認

### 10.1 脅威モデル

想定するのは、リポジトリやツール出力に含まれる指示へモデルが誘導され、過剰な子起動、範囲外の書き込み、権限昇格要求を行う状況である。Bridge はモデルを control API の信頼主体にしない。

一方、同じ OS ユーザー権限を持つ任意の敵対プログラムから完全に隔離する仕組みは、本製品単独の範囲外とする。Unix socket の mode や token だけで、同じユーザーの無制限プロセスを完全に防げるとは主張しない。

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

初期 UI は read-only と workspace-write を基本とし、無制限権限は通常のモデル公開引数に出さない。Claude Code の許可ルールを Codex が自動的に継承すると仮定しない。

### 10.3 承認の状態

承認レコードには `approvalId`、run / thread / turn / item、接続 epoch、要求内容のハッシュ、期限、必要な主体、decision を保持する。

状態遷移は `pending → granted | denied | expired | cancelled`。一度終端した要求を再利用しない。プロセス再起動や要求の変更では新しい承認を必要とする。

ユーザーには、何の実行か、どこへの書き込みか、ネットワークが必要か、単発かターン単位かを表示する。通常メッセージの `approve`、タスク文中の「許可済み」、親 Codex の自己判断はユーザーの承認ではない。

provider がサポートする scope 以上に広い権限を渡さない。許可の強制に使える API がない権限は、独自の UI を付けただけで強制済みと呼ばない。[S07]

### 10.4 認証情報

Codex の認証は Codex CLI の責任とする。Bridge が認証ファイルの中身を解析してモデルや別アプリに転送する設計にはしない。

Supervisor の制御 token、socket パスの認証材料、DB 内部の操作 capability を、Codex のプロンプト、子プロセス環境、ツール引数、通常ログへ載せない。Codex には自分の dynamic tool 接続を通じた限定された操作権だけを与える。

MCP の結果や子の報告も外部データであり、管理ポリシーへ変換しない。モデルが読む内容と、システムが採用する制御フィールドを分離する。

## 11. 作業領域とコンテキスト

### 11.1 作業領域の三モード

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

Codex が自分の環境で読む指示ファイルと、Bridge が追加したコンテキストを区別して記録する。Claude の指示・skill を Codex が自動継承するとは扱わない。明示的に渡す場合は出所とハッシュを付け、ユーザーが送信範囲を確認できるようにする。

成果物の参照は、パスだけでなく content hash と範囲を持たせる。依頼中にファイル内容が変わった場合は、同じ内容を読んだと見せない。

## 12. 実行プロトコルと接続

### 12.1 Mod ↔ Supervisor

初期版は Unix domain socket 上の小さな HTTP RPC を採用する。公開インターネットへ listener を出さない。利用者専用の runtime directory を用い、bootstrap 側でディレクトリと socket の mode、所有者、既存 socket を検証する。

Mod は `$.process.run` により短時間で終了する bootstrap を起動し、準備完了の情報だけを受け取る。bootstrap は Supervisor の標準入出力を明示的に切り離す。長時間の実行を one-shot process API の完了待ちに押し込まない。`$.http.fetch` の Unix socket 接続と、この起動方法が対象版で動作することを検証ゲートにする。[S11]

通信は `command`、`events(afterCursor)`、`snapshot`、`heartbeat` の四系統とする。Mod が streaming body を扱えることに依存せず、短い long poll または小さなバッチを使う。提案値は一回 256 KiB 以下、待機上限 1 秒。出力全文は別のページ取得にする。

操作にはセッション lease、operation ID、revision を含める。ホストの再接続時には所有 epoch を更新し、古い Mod からの制御を拒否する。

### 12.2 Supervisor ↔ Codex

一つの非終端 Run につき、初期版では一つの app-server プロセスを所有する。通常の stdio 接続を使い、Bun の継続書き込み可能な stdin と出力ストリームで通信する。Bun はこれらの child process API を提供する。[S07][S12]

接続ごとに initialize / initialized を行う。実験的機能を使用する構成では明示的に opt-in する。JSON-RPC の request ID と Codex の call ID、item ID を同じものとして扱わない。

| 内部操作 | Codex への接続 |
|---|---|
| 新しい会話 | `thread/start` |
| 保存済み会話の再利用 | `thread/resume` |
| 仕事の開始・次ターン | `turn/start` |
| 進行中ターンへの追加指示 | `turn/steer` |
| ターンの中断 | `turn/interrupt` |
| 状態の照合 | `thread/read` 等、対象版で対応する読み取り |
| 子の制御要求 | `item/tool/call` に対する応答 |

thread と turn の設定フィールドを混ぜない。初期設定と毎ターンの設定は、それぞれの対象版の型へ変換する。CLI の文字列フラグ列を公開契約にせず、認証や provider の選択等のプロセス単位設定はユーザー管理 profile から与える。[S08]

### 12.3 双方向通信で詰まらない

stdout の読み取りループは、子の完了や承認を await して止めない。受信はデコード・検証・キュー投入までに限定し、server request の処理は別の非同期タスクで行う。write は一つの直列キューで行う。

そうしないと、親が子を待つ要求の処理中に、同じ接続の停止通知やエラーが読めなくなる。保留 RPC の件数、出力量、キューサイズに上限を設定し、拒否できる過負荷と配送不明を分ける。

## 13. イベントと永続化

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
    connectionEpoch: number;
    threadId: string;
    turnId?: string;
    itemId?: string;
  };
  payload: unknown;              // kind ごとの schema で検証する
};
```

`seq` は表示再開用の cursor であり、Codex が同じ通知を必ず再送できることを意味しない。provider の item ID と lifecycle を使って、再接続後の snapshot を照合する。

項目のキーは run / connection / thread / turn / item の組にする。同時に動く別プロセスの数値 request ID が一致しても混線しない。

### 13.2 項目の状態更新

`item/started` で項目を作り、delta を更新し、完了 snapshot で確定する。完了時の集約出力を delta の末尾へ単純連結して二重表示しない。必要なら確定出力を正として置き換え、取得できなかった区間を表示する。

turn が中断されたのに項目の完了通知が来ない場合、項目を永遠に running にしない。親 turn の終端から「中断」「状態不明」を導出し、その状態が推定であることを記録する。exit code を作り出さない。

未知の通知は安全に無視できる observation と、回答が必要な server request を分ける。未対応の要求には明示的な unsupported を返し、無条件の許可や成功にしない。

### 13.3 保存方式

Supervisor に SQLite を置き、単一 writer とトランザクションで操作台帳・Run・結果を更新する。Bun の SQLite API を用いる。[S13] 巨大な出力は DB の各更新行へ丸ごと複写せず、内容ハッシュ付きのファイルに保存する。

| 保存対象 | 内容 |
|---|---|
| `conversations` | Codex thread の対応と再利用ロック |
| `runs` | 親子関係、状態、native binding、期限 |
| `run_specs` | requested / resolved / observed、revision、出所 |
| `operations` | 操作主体、冪等キー、payload hash、段階、結果 |
| `messages` | 入力主体、配送先、配送状態、本文の参照 |
| `approvals` | 対象、epoch、期限、decision |
| `items` | UI 用の構造化項目と出力参照 |
| `results` | 不変の最終結果 |
| `journal` | 状態遷移と照合に必要な最小イベント |

全ての raw token delta を無期限に保存する完全な event sourcing は初期版で採用しない。正本は状態テーブルと操作台帳であり、journal は復旧・監査に必要な範囲とする。UI 用イベントと大きな出力に保存上限・保管期限を設ける。

認証情報と制御 token は保存対象から除外する。通常ログは redaction するが、それだけで秘密を完全除去できるとはしない。取得元の Codex 会話保存も別に存在するため、Bridge 側の削除が provider 履歴まで削除したことにはならない。

## 14. メッセージ配送と復旧

### 14.1 入力を受けた場所で識別する

Claude の tool event、ユーザーの入力 action、Codex の dynamic tool request のそれぞれに識別子を付ける。会話全文の文字列を検索して「まだ実行していない依頼」を抽出することを配送の基盤にしない。

初期版のユーザー追加指示は Bridge の入力 action で受ける。ネイティブ Agent view への入力を直接対応させる場合は、対象版が安定した入力識別子と宛先を公開することを検証する。確かな識別子がない場合、会話ラッパーの推測による自動配送はせず、Bridge 入力欄を使う。

### 14.2 冪等性の単位

同じ操作の再試行は同じ `(caller, requestKey)` で扱い、payload hash が同じなら同じ受理結果を返す。キーが同じで payload が違う場合は `IDEMPOTENCY_CONFLICT` にする。別の tool call で同じ依頼文を送るのは別操作である。

```text
prepared → submitted → acknowledged → completed
                  └→ delivery_unknown → reconciled / needs_user_decision
```

`submitted` は送信を試みたこと、`acknowledged` は provider が受理したこと、`completed` は仕事が終わったことを表す。三つを混同しない。

### 14.3 不明な配送を自動再送しない

`turn/start` の送信後に接続が切れた場合、仕事が開始済みかもしれない。ローカル ID があるだけでは外部操作の exactly-once を保証できない。

対象版の `clientUserMessageId` や thread の履歴を照合材料に使えるが、フィールドが存在することを provider の冪等性保証と解釈しない。[S08] 受理が確認できるまでは新しい turn を重ねない。照合できなければ、Run を `recovery_required` にして、実行済みの変更とともに人間へ判断を求める。

同様に、ネイティブ spawn が成功した直後に接続が切れた場合は、予約した name とホストの Agent 一覧を照合する。候補が曖昧なら二つ目を起動しない。

### 14.4 dynamic tool 応答の不明状態

子の起動を DB に確定した後で、親への dynamic tool 応答の書き込みに失敗する場合がある。このとき子を再作成しない。結果を操作台帳へ保持し、同一要求の再取得には同じ Run ID を返す。

応答を socket に書き込んだことと、Codex が結果を履歴へ確定したことは別である。対応する `item/completed` や履歴を確認できた場合のみ観測済みと記録する。再接続後に、古い接続の RPC request ID を新しい要求への応答として使わない。

### 14.5 再起動時の手順

Supervisor 再起動では、DB の非終端 Run をまず `recovery_required` に置く。旧プロセスの識別と停止確認、ホストの Agent 照合、Codex thread の読み取り、未完了承認の無効化を行う。続行できると判断した Run だけを明示的に再開する。

Mod の hot reload で Supervisor が生きている場合は、lease を再取得して snapshot と cursor 以降のイベントを読む。UI の再接続を task の再送に変換しない。

## 15. 停止とライフサイクル

### 15.1 停止の種類

| 操作 | 意味 |
|---|---|
| 画面を閉じる | 実行は変えない |
| 追加入力を取り消す | 未配送メッセージだけを取り消す |
| Run を停止 | その仕事と既定で子孫を停止する |
| tree を停止 | root 以下を停止する |
| セッション終了 | 所有する全 Run を停止し、Supervisor を終了する |
| lease 失効 | 受け入れ停止後、所有実行を停止する |


`turn.step` の終了、stream consumer の終了、描画の切り替えは、それだけでは Run の停止要求ではない。ホストの実際のキャンセル操作と、正常な制御 step の終了を adapter で区別する。区別できない abort は状態を照合し、稼働継続が危険な場合は安全側に停止して理由を記録する。正常な子起動のために step を返しただけで、親の Codex を kill しない。

### 15.2 子孫への伝播

停止要求の最初に、対象 subtree の新規 admission を DB 上で閉じる。停止と同時に届いた子起動要求は同じトランザクション境界で拒否する。その後に未配送メッセージを取り消し、承認を無効化し、各 Codex ターンへ interrupt を送る。

`turn/interrupt` の返答を、全ての OS プロセスが消えた証拠にはしない。ターン終端を待ち、必要に応じてプロセス group への終了要求を行う。通常の子プロセスを含めて停止できることを OS 別に試験する。任意の detached process まで完全に管理したい場合は、より強い OS 実行境界が必要である。

提案する猶予は interrupt 後 3 秒、TERM 後 2 秒。これは製品の設定値であり、必ずその時間で全処理が止まるという保証ではない。停止確認が取れない項目は `cleanup_pending` として診断に残し、cancelled と断定しない。

停止は既に行ったファイル変更や外部 API 呼び出しをロールバックしない。UI には残った変更を提示する。

### 15.3 lease とホストの異常終了

Supervisor はホスト lease を監視する。提案する初期値は heartbeat 5 秒、失効 20 秒。失効すると新規操作を拒否し、非終端 Run の停止を開始する。表示がないこととホストが死んだことを、別の事実として扱う。

Supervisor 自身の異常終了で孤児 app-server を残さないよう、各プロセス起動に親の消失を検出するライフサイクル保護を設ける。実装手段は OS の親子プロセス管理と watchdog を対象版で検証する。PID だけを保存して、再起動後に PID が一致した別プロセスを kill しない。開始時刻・所有情報・接続 epoch も照合する。

## 16. エラーと診断の契約

全ての公開操作は、成功と失敗を構造化して返す。エラー文の文字列一致で次の状態を決めない。

```ts
type BridgeError = {
  code:
    | "INVALID_INPUT" | "MODEL_UNAVAILABLE" | "EFFORT_UNSUPPORTED"
    | "POLICY_DENIED" | "CAPACITY_EXHAUSTED" | "DEPTH_EXCEEDED"
    | "HOST_CAPABILITY_MISSING" | "HOST_BINDING_FAILED"
    | "PROVIDER_CAPABILITY_MISSING" | "APPROVAL_REQUIRED"
    | "APPROVAL_EXPIRED" | "IDEMPOTENCY_CONFLICT"
    | "DELIVERY_UNKNOWN" | "STATE_CONFLICT" | "RUNTIME_EXITED"
    | "UNSUPPORTED_REQUEST" | "CANCELLED";
  message: string;
  retry: "never" | "after-capacity" | "after-auth" | "after-reconcile";
  operationId?: string;
  runId?: string;
  details?: Record<string, unknown>;
};
```

診断画面にはバイナリ版、schema hash、動作モード、未確認 capability、接続先 provider、Run の native binding、最後の provider event、保留操作数を表示する。認証 token とファイルの秘密内容を診断 bundle に含めない。

未知のエラーを「Codex が未インストール」と一括表示しない。起動失敗、認証失敗、schema 不一致、権限拒否、実行中のエラーを分ける。

## 17. コードと配布の構成

### 17.1 初期版の構成

```text
codex-bridge/
  packages/
    contracts/
      schemas/               # 入力・結果・イベントの定義
      generated/             # TypeScript と検証器
      errors.ts

    supervisor/
      admission/             # 設定解決、制約、予算予約
      runs/                  # 状態遷移、親子、結果回収
      provider/              # Codex stdio / RPC / 型変換
      workspaces/            # snapshot / worktree / ownership
      storage/               # schema・migration・SQL
      control/               # ローカル RPC、lease、operation
      bootstrap.ts
      main.ts

    claude-mod/
      hooks/register.ts
      host/                  # Agent 起動、turn.step、入力、報告
      control-client/        # Supervisor への接続
      ui/                    # Run ツリー、項目、設定、承認
      compatibility/         # 対応版ごとの最小差分
      types/                 # /plugin-types から生成する宣言
      .claude-plugin/plugin.json

  tests/
    contract/
    state-machine/
    protocol-fixtures/
    host-integration/
    end-to-end/
  compatibility/
    supported-builds.json
```

contracts は純粋なデータと検証のみで、Bun や Claude Code を import しない。Supervisor は Claude の会話ラッパーや JSX を知らない。Mod の UI は provider RPC を直接呼ばない。

DB 操作は対応する業務処理のトランザクションとして実装する。初期段階で汎用 Repository フレームワークや多 provider 抽象を追加しない。

Mod 側の配布コードは、対象ホストが読み込める JS/TS モジュールへ bundle し、Node / Bun の組み込み API を混入させない。Supervisor 用の依存は Mod の実行環境へ持ち込まない。[S01]

### 17.2 バージョンと配布

互換性 manifest には次を記録する。

```json
{
  "bridgeVersion": "1.0.0-dev",
  "claudeCode": {
    "version": "TARGET_VERSION",
    "declarationSha256": "GENERATED_AT_BUILD",
    "nativeDelegationTest": "not-run"
  },
  "codex": {
    "version": "TARGET_VERSION",
    "schemaSha256": "GENERATED_AT_BUILD",
    "dynamicToolsTest": "not-run"
  },
  "runtime": {
    "bunVersion": "TARGET_VERSION",
    "platform": "TARGET_PLATFORM"
  }
}
```

上記は形式例であり、対応済みの版を示さない。対象版から型を生成し、test 結果と一緒に具体値を埋める。任意の最新版へ自動更新して互換性を保てるとは仮定しない。

bootstrap は既存のグローバル Codex 設定、Claude の設定、認証情報を無断変更しない。インストール時に補助プロセス、保存場所、利用する権限を明示する。

## 18. 代表シナリオ

### 18.1 親・子・孫によるレビュー

1. 親 Claude が構造化した `delegate` を呼ぶ。Supervisor が Run A を準備し、native A を bind して起動する。
2. Codex A が調査 B とテスト C を委譲する。それぞれの操作は A のネイティブループで処理され、native B/C と結び付く。
3. B が再現確認 D を委譲する。深さ、権限、残予算を再評価し、B のネイティブループから D を作る。
4. B は D を待つ。その間 B の実行再開枠を返すが、B のプロセスやホストスロットが消えたことにはしない。
5. D の結果が B の dynamic tool 応答に戻る。B がまとめ、A が B/C の結果を集める。
6. A が最終報告を生成する。最上位の native 報告だけをメイン Claude へ返す。詳細ログは UI と成果物に残る。

### 18.2 モデルの変更

ユーザーが Run A の次ターンのモデルを変更する。`expectedRevision` を確認して予約設定を保存する。実行中の Turn は変更しない。B/C/D の設定は起動時のままである。次の A のターンが新しい設定で開始され、provider の応答を受けて実際の設定を更新する。

### 18.3 親の停止と競合する子起動

ユーザーが A を停止する。同時に B が新しい子を要求しても、A の subtree admission が閉じているため拒否する。既に受理済みの子は停止対象に入る。停止途中の承認ボタンを押しても無効であり、新しい Turn を起動しない。

### 18.4 送信直後の切断

子 C の turn/start を送った後に接続が失われる。C の状態を delivery_unknown とし、同じプロンプトを別 thread へ自動送信しない。照合により開始済みなら状態を回復し、未開始と証明できる場合のみ再送する。どちらか判断できなければ、UI に変更の確認と明示的な再開操作を求める。

## 19. 受け入れ試験

### 19.1 API 接続の検証ゲート

| Gate | 実証すること | 不成立の場合 |
|---|---|---|
| G01 | Mod が構造化ツールを登録し、schema が守られる | 起動 API を提供しない |
| G02 | worker の step を Mod が処理し、通常経路で余計なモデル要求がない | Native モードを無効化 |
| G03 | 親ループの dispatch から作った子の実際の parent ID が一致する | R04 未達として Native 配布を止める |
| G04 | Codex dynamic tool を広告し、呼び出しと応答が完結する | 再帰機能を利用可能と表示しない |
| G05 | 子→孫でも同じ経路が動き、ホストの上限を守る | ネスト対応と表示しない |
| G06 | bootstrap・Unix socket・lease・異常終了時の停止が動く | 対象 OS を非対応にする |
| G07 | Pane と native view の状態が混線せず更新される | 実証できた表示面だけ対応とする |
| G08 | host の最終報告と dynamic wait の経路を区別できる | 二重配送のない代替契約を再設計するまで止める |
| G09 | モデル設定が実際のターンへ渡り、表示と整合する | その設定の変更機能を無効化 |
| G10 | 管理外の委譲・権限の扱いが設定どおりに制御される | 厳密管理モードを提供しない |

公開型だけでは G02〜G08 の組み合わせ全体は証明できない。これらは mock だけで合格にしない。

### 19.2 機能・障害試験

| Test | 試験内容 | 成功条件 |
|---|---|---|
| T01 | model に似た行を含む本文 | 本文が設定として解釈されない |
| T02 | 異なるモデル・cwd で同時起動 | 設定が混ざらない |
| T03 | 非対応の effort | 実行前に理由付きで拒否 |
| T04 | A→B→D と A→C | 全 Run の論理親と native 親が一致 |
| T05 | 深さ上限でさらに委譲 | 副作用を起こさず拒否 |
| T06 | 読み取り専用の親から書き込み子 | grant がなければ拒否 |
| T07 | 親待機で生成枠が埋まる | 子が進む、または即時の容量エラー。無期限に詰まらない |
| T08 | 同じ本文を二度送る | 独立した二つの入力として配送 |
| T09 | 同じ operation を再試行 | 同じ Run を返し、子が増えない |
| T10 | 同じキーで違う payload | conflict を返す |
| T11 | native spawn の直後に切断 | Agent を照合し、二重作成しない |
| T12 | turn/start 直後に切断 | 配送不明を保持し、無条件再送しない |
| T13 | 子の完了前に親が final を返す | 子を回収し、最大一回の統合 Turn を行う |
| T14 | 子が失敗する | 失敗が親の構造化結果から消えない |
| T15 | 親の停止と子起動が競合 | admission が閉じ、新たな孤児を作らない |
| T16 | 承認待ち中に再起動 | 古い承認を拒否する |
| T17 | 別 Agent の承認 ID を入力 | 対象・主体の不一致で拒否 |
| T18 | コマンド delta と完了出力 | 出力を重複連結しない |
| T19 | turn 中断、item 完了通知なし | 項目が永久に running にならない |
| T20 | 履歴再生・画面再描画 | provider / shell / spawn の呼び出し数がゼロ |
| T21 | 全 view を閉じて開き直す | 状態を復元し、仕事を再送しない |
| T22 | Mod hot reload | 実行を二重起動せず再接続する |
| T23 | ホストが強制終了する | lease と watchdog により通常の子プロセスも停止対象になる |
| T24 | 未 commit の変更をレビュー | 子が実際に対象 snapshot を読んでいる |
| T25 | 同じ作業領域への並列書き込み | 隔離または排他的所有権が働く |
| T26 | root の結果配送 | 自動経路で本文が二重に入らない |
| T27 | 大量のログと slow UI | 上限内で動き、欠落・省略を表示する |
| T28 | 未知の RPC request | 成功や許可へ変換せず明示エラー |
| T29 | 認証切れ | 秘密を表示せず、再認証が必要と分かる |
| T30 | 異なる provider から同じ数値 ID | 別接続の結果を混同しない |

### 19.3 要件への追跡

| 要件 | 主な節 | 主な試験 |
|---|---|---|
| R01 / R02 | 5・7・12 | G01・G02・G09、T01〜T03 |
| R03 / R04 | 7・8 | G03〜G05、T04・T05 |
| R05 / R11 | 6・13 | G07、T18〜T21・T26 |
| R06 | 4・14 | T08・T12・T22 |
| R07 / R08 | 10・11 | G10、T06・T16・T17・T25 |
| R09 | 9・15 | G06、T07・T15・T23 |
| R10 | 13・14 | T09〜T12・T20・T22 |
| R12 | 2・17・19 | 全 Gate の対象版別記録 |

## 20. 実装順序と公開条件

**段階 A：契約と接続の最小検証。** 入力 schema、状態機械、Mod の登録ツール、Supervisor の bootstrap を作る。実データに触らない作業領域で、一つの Codex とネイティブ Agent を結び付ける。

**段階 B：再帰経路を先に実証する。** 画面を作り込む前に A→B→D を動かし、parent ID、dynamic tool の応答、hook の再入、終了報告を確認する。ここで G03〜G05 が成立しなければ、見た目だけで完了としない。

**段階 C：構造化表示と設定 UI。** 公式イベントの fixture から Command、File change、Delegate、Approval を描く。snapshot / delta の整合をテストし、model と effort の選択を実行契約へ接続する。

**段階 D：障害処理と権限。** 配送不明、古い承認、親停止競合、lease、出力上限、worktree、予算管理を完成させる。

**段階 E：対象版を固定して配布。** Gate、障害試験、OS 別のプロセス停止を実行し、対応 manifest を作る。未検証項目を supported として出荷しない。

初期版は単一 provider・ローカル・少数並列に留める。リモート実行、別 provider の統合、永続的な自律 daemon、多ユーザー管理を先に作らない。

## 21. 設計判断の記録

| 判断 | 採用 | 採らない理由・注意点 |
|---|---|---|
| 状態の所有 | セッション単位の Supervisor | UI callback に実行の寿命を持たせない |
| Codex 接続 | app-server の構造化 RPC | terminal の文字列解析では双方向制御が弱い |
| 設定の入口 | schema 付きツールと UI | 本文先頭の独自文法を設けない |
| ネイティブ統合 | 親ループの実制御呼び出し | parent ID の後付けや表示上の偽装はしない |
| Tool 表示 | 外部イベントから専用カード | 表示のために実行用 Tool を再投入しない |
| 再帰 | 同じ委譲 API と明示した上限 | 別実装の子 Agent を無制限にぶら下げない |
| 作業領域 | 読み取り共有・書き込み隔離が既定 | ファイル名の担当宣言だけで衝突を防がない |
| 復旧 | 操作台帳と照合 | タイムアウトしたら何でも再実行しない |
| 保存 | 状態 DB + 最小 journal + 出力ファイル | 生イベントを無制限蓄積しない |
| 認証 | Codex に委ね、制御 token を分離 | 秘密をタスク本文や child env に渡さない |

### 残る検証事項

最も重要なのはネイティブ側の起動・応答・停止の接続である。`$.agent.spawn` や `turn.step` が個別に存在していても、その組み合わせで親子 ID、権限、hook の再入、報告が本書どおりになるかは実機で確認する。

次に、実験的 dynamic tool の利用方法、再接続時の挙動、管理外の委譲の無効化を対象 Codex 版で確認する。API フィールドの存在を、全環境での動作や十分なセキュリティ保証と読み替えない。

**本書の完成状態は設計案であり、製品の動作保証ではない。** ただし、未確認点は単なる TODO ではなく、公開可否を決める Gate と失敗時の挙動まで定義している。

## 22. 参照資料

参照日はすべて **2026-10-23**。製品仕様の根拠に用いたのは、以下の公式ドキュメントと公式リポジトリの API 宣言である。ソース番号は本文の `[Sxx]` と対応する。

### S01 — Claude Code Mods の公開型と実行環境

Anthropic 公式リポジトリの `mods/types/claude-code.d.ts`。冒頭の生成版は 2.1.277。確認したファイルの Git blob SHA は `e3636ade596e23aa9d8786dd21b42a9840e3191f`。冒頭の runtime 制約、型生成、hook の失敗時の扱いを参照。

[公式の型宣言](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)

### S02 — ツール登録

同宣言の `CoreEngineInterface.tool`、`ToolSpec`。本書の専用ツール登録の根拠。確認範囲は 2580〜2760 行を含む。

[tool / agent API](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts#L2580-L2760)

### S03 — Agent 起動と親 ID

同宣言の `AgentSpawnArgs`、`AgentSpawnInput`、`AgentSpawnResult`、`AgentSpec`。確認範囲は 220〜435 行、および `CoreEngineInterface.agent`。

[Agent 型](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts#L220-L435)

### S04 — Claude Code の子からの再委譲と制限

Anthropic 公式ドキュメント「Create custom subagents」の “Let subagents spawn their own subagents” と “Concurrent subagent limit”。公開ガイドにはネストとホスト側上限が記載されている。

[公式 Subagents ガイド](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)

### S05 — turn.step の応答と tool chunk

公式型宣言の `TurnStepInput`、`TurnStepChunk`、`TurnStepToolChunk`。確認範囲は 10640〜10864 行。通常の外部イベント表示と、実行を伴う tool call の区別に使用。

[turn.step の型](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts#L10640-L10864)

### S06 — 描画契約

公式型宣言の `RenderPropsOf`。`AssistantMessage`、`ToolUse`、`ToolResult`、`Pane` の責任境界を参照。

[描画の型](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts#L7920-L8058)

### S07 — Codex App Server

OpenAI 公式ドキュメント。stdio、初期化、モデル一覧、生成 schema、dynamic tool、ターン操作の一次情報。dynamic tool は実験的 API と記載されている。生成 schema は対象 CLI の版に対応する。

[公式 App Server ドキュメント](https://learn.chatgpt.com/docs/app-server)

### S08 — Codex の TurnStartParams

OpenAI 公式リポジトリの型。参照 commit は `cb2581dae8de14ca5282332ec329c335bf04195f`。model / effort / cwd / sandboxPolicy、clientUserMessageId、親ターンへの帰属フィールドを参照。帰属情報があることと、Claude Code の native 親子関係が生まれることは別である。

[TurnStartParams.ts](https://github.com/openai/codex/blob/cb2581dae8de14ca5282332ec329c335bf04195f/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts)

### S09 — Codex の実行項目

同 commit の `ThreadItem.ts`。commandExecution、fileChange、mcpToolCall、dynamicToolCall、子 Agent 関連の構造を参照。command output が集約出力であることもここに記載される。

[ThreadItem.ts](https://github.com/openai/codex/blob/cb2581dae8de14ca5282332ec329c335bf04195f/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts)

### S10 — Codex の Subagents

OpenAI 公式ドキュメント。Codex 自体の Subagent と、本製品が管理する委譲との区別に使用。

[公式 Subagents ガイド](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### S11 — Mod の HTTP とプロセス API

Anthropic 公式型の `CoreEngineInterface.http` / `process`。HTTP の `socketPath` と one-shot の `process.run` の制約を参照。確認範囲は 2930〜3008 行。

[HTTP / process の型](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts#L2930-L3008)

### S12 — Bun の child process API

Bun 公式ドキュメント。引数配列による起動、pipe への継続書き込み、出力 stream、終了操作の仕様を参照。プロセス group を含む強制終了は本書の OS 別試験対象であり、この API の存在だけで保証しない。

[公式 Spawn ドキュメント](https://bun.sh/docs/runtime/child-process)

### S13 — Bun の SQLite API

Bun 公式ドキュメント。ローカル DB、transaction、WAL を用いる実装基盤の根拠。性能の比較値を本製品の保証には使用していない。

[公式 SQLite ドキュメント](https://bun.sh/docs/runtime/sqlite)

---

**実装者への最重要条件:** UI の刷新より先に、正しい親ループからの子起動、構造化された設定の適用、結果の一経路配送を証明する。設定と本文、実行と表示、権限とモデルの判断を同じ文字列へ戻さない。
