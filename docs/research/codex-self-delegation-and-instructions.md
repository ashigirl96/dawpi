# Codex 自身の委譲を止め、個人の AGENTS.md を読ませずに起動する方法

issue #6 の調査結果。対象は codex-cli 0.163.0（`rust-v0.163.0` tag）。設計書 v1 の 8.5、10.4、11.2 と、検証ゲート G10 の前提にあたる。

調べた日は 2026-10-23。turn は一度も流しておらず、token は使っていない。実機で動かしたのは次の 3 つだけで、どれも空の一時 `CODEX_HOME` を使い、`~/.codex` には触れていない。

- `codex features list`、`codex debug models`、`codex debug prompt-input`（model に request を送らず、model に渡す入力の一覧を JSON で出す）
- 自前の `codex app-server`（stdio）に対する `initialize`、`config/read`、`experimentalFeature/list`、`configRequirements/read`、`account/read`、`thread/start`（ephemeral）、`mcpServerStatus/list`
- 起動した process は、それぞれの probe の終わりで kill した

確度の表記は 3 段階で書く。

- **一次資料で確定**: 公式 docs、0.163.0 の source、実機の観測のどれかで裏が取れている
- **生成型や help からの推論**: 生成した型、`--help`、source の一部から推した
- **不明（実機の turn が必要）**: turn を流さないと確かめられない

## 結論

| 経路 | 止め方 | 確度 |
|---|---|---|
| multi-agent（v1 / v2） | `-c agents.enabled=false` を必ず付ける。`--disable multi_agent` だけでは止まらない | 一次資料で確定 |
| effort `ultra` | `agents.enabled=false` にすれば、委譲の指示が消えて普通の高 effort になる。Bridge 側で `ultra` を送らないことも併せて行う | 一次資料で確定 |
| approvalsReviewer の subagent | `thread/start` と `turn/start` に `approvalsReviewer: "user"` を明示する。保険として `--disable guardian_approval` と `-c approvals_reviewer="user"` も付ける | 一次資料で確定（managed requirements が無い前提） |
| review | client が `review/start` を呼んだときにしか始まらない。Bridge が呼ばなければ起きない | 一次資料で確定 |
| 個人の `~/.codex/AGENTS.md` | `CODEX_HOME` を分けるしかない。`baseInstructions`、`developerInstructions`、`project_doc_max_bytes` では消えない | 一次資料で確定 |
| config の MCP server | `CODEX_HOME` を分ける。`-c mcp_servers={}` では消えない。server ごとの `enabled=false` は効くが、名前を知る必要がある | 一次資料で確定 |
| ChatGPT 認証の引き継ぎ | 分けた `CODEX_HOME` でユーザーに一度 `codex login` してもらうのが、Bridge が認証ファイルに触れずに済む唯一の確実な方法 | 一次資料で確定（symlink 共有は推論） |

起動の例を示す。

```sh
CODEX_HOME=<Bridge 専用の dir> codex app-server --listen stdio:// \
  -c agents.enabled=false \
  --disable multi_agent --disable multi_agent_v2 \
  --disable guardian_approval \
  -c approvals_reviewer='"user"'
```

`thread/start` には `approvalsReviewer: "user"` を入れ、`config` で `model_reasoning_effort` に `ultra` を渡さない。`turn/start` でも `effort: "ultra"` と `approvalsReviewer: "auto_review"` を送らない。

## 1. Codex 自身の委譲経路を止める

### 1.1 multi-agent: `features.multi_agent=false` だけでは止まらない

**一次資料で確定**（source と実機）

0.163.0 では、thread が使う multi-agent の版を次の順で決める（[`core/src/config/mod.rs` L1637-1664](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs#L1637-L1664)）。

1. `features.multi_agent_v2` が true なら V2
2. `agents.enabled` が false なら Disabled
3. 上のどちらでもなければ、model catalog の `multi_agent_version` を使う
4. catalog に値が無いときだけ、`features.multi_agent`（内部名 `Collab`）で V1 か Disabled を選ぶ

`model/list` に出る model は、`gpt-5.6-luna`（v1）と `gpt-5.5`（値なし）を除いて、どれも catalog で `multi_agent_version = v2` を持つ（`codex debug models` の bundled catalog で確認）。このため既定の `gpt-6.1-sol` では `--disable multi_agent` が効かず、V2 の multi-agent が残る。

止めるには `agents.enabled=false` を使う。公式の config reference には「`agents.enabled` — Enable or disable multi-agent tools (default: true).」とある（[config reference](https://learn.chatgpt.com/docs/config-file/config-reference)）。source 側の定義には「An enabled `features.multi_agent_v2` setting takes precedence.」と書かれている（[`config/src/config_toml.rs` L758-761](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/config_toml.rs#L758-L761)）。このため `multi_agent_v2` も false のまま固定する。

Disabled のとき、spawn・wait などの collab tool は登録されない（[`core/src/tools/spec_plan.rs` L728-753](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/spec_plan.rs#L728-L753) の `collab_tools_enabled` は `Disabled => false` を返す）。

実機で `codex debug prompt-input` を空の `CODEX_HOME` で回し、model に渡す developer message を比べた。

| 起動の設定 | `<multi_agent_role>` | `<multi_agent_mode>` |
|---|---|---|
| 既定 | ある | ある（explicit request only） |
| `model_reasoning_effort="ultra"` | ある | ある（「Proactive multi-agent delegation is active.」） |
| `ultra` + `--disable multi_agent` | ある | ある（proactive のまま） |
| `ultra` + `-c agents.enabled=false` | 無い | 無い |

起動時の `-c` と `--enable/--disable` は app-server にも同じ形である。`--disable X` は `-c features.X=false` と同じ意味である（`codex app-server --help`）。`thread/start` の `config` でも `{"agents.enabled": false}` を渡せる（実機で受理を確認）。ただし起動引数で決めておけば、client の書き忘れに左右されない。

### 1.2 effort `ultra`

**一次資料で確定**（source と実機）

`ultra` は独立した委譲の仕組みではない。multi-agent が V2 のときに、`<multi_agent_mode>` を proactive に切り替えるだけである（[`core/src/session/multi_agents.rs` L77-121](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/multi_agents.rs#L77-L121)。V2 以外では `None` を返す）。model に送る effort は `multi_agent_reasoning_effort`（`gpt-6.1-sol` では `xhigh`）か `max` に読み替える（[`protocol/src/openai_models/reasoning_effort.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/openai_models/reasoning_effort.rs)）。

したがって `agents.enabled=false` で委譲の部分は止まる（上の表の 4 行目）。設定値そのものは通るので、`ultra` を受けても `thread/start` の応答は `reasoningEffort: "ultra"` になる（実機）。Bridge の公開 API では `ultra` を拒否し、受け付けた effort と `reasoningEffort` の値が一致するかを確かめる。

`thread/start` の `multiAgentMode` は deprecated で無視される。応答の `multiAgentMode` も常に `explicitRequestOnly` を返す（生成型の doc comment と実機）。観測には使えない。

### 1.3 approvalsReviewer（`auto_review` / `guardian_subagent`）

**一次資料で確定**（source と実機。managed requirements が無い前提）

- `guardian_subagent` は `auto_review` の旧名で、受け付けると `auto_review` に正規化される（[`protocol/src/config_types.rs` L177-200](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/config_types.rs#L177-L200)。実機の `thread/start` 応答も `auto_review` になった）。
- 既定は `user` である。guardian に回るのは、approval policy が `on-request` か granular で、かつ reviewer が `auto_review` のときに限る（[`ext/guardian-reviewer/src/routing.rs` L54-62](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/guardian-reviewer/src/routing.rs#L54-L62)）。
- `--disable guardian_approval` を付けても、`thread/start` の `approvalsReviewer: "auto_review"` はエラーにならず、そのまま受理された（実機）。止める決め手は「Bridge が `user` 以外を送らない」ことで、feature はその保険になる。MCP の承認経路は feature が off なら guardian に回らない（[`core/src/session/mcp.rs` L907-925](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/mcp.rs#L907-L925)）。
- reviewer の設定は top-level のほかにもある。apps（ChatGPT の connector）には `apps._default.approvals_reviewer` と `apps.<id>.approvals_reviewer` がある（[app-server docs](https://learn.chatgpt.com/docs/app-server)、[`config/src/types.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/types.rs)）。`CODEX_HOME` を分ければ、ユーザーのこれらの設定は入らない。
- 例外がある。managed requirements（system の `requirements.toml` か MDM）の `auto_review_required_models` に入った model では、reviewer が強制的に `auto_review` になる（[`core/src/session/mod.rs` L751-783](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/mod.rs#L751-L783)）。この Mac の `configRequirements/read` には該当する値が無かった（実機）。Bridge は起動時に `configRequirements/read` を読み、`autoReview`、`allowedApprovalsReviewers`、`featureRequirements` が設定されていれば、厳密モードでの起動を拒否する。

`--approve-for-me`（TUI の flag）は auto review を有効にするので使わない。

### 1.4 review

**一次資料で確定**（source）

review の task は、client の `Op::Review` からしか始まらない（[`core/src/session/review.rs` L176](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/review.rs#L176)。`app-server` では `review/start` がこれを呼ぶ）。model が呼べる tool から review を始める経路は無い。review の sub-agent は collab tool を外して動く（[`core/src/tasks/review.rs` L105-116](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tasks/review.rs#L105-L116)）。

止めるための flag は無く、また要らない。Bridge が `review/start` を呼ばなければ review は起きない。

### 1.5 起動後に止まっていることを確かめる方法

| 何を見るか | 方法 | 確度 |
|---|---|---|
| 起動引数が効いたか | `config/read { includeLayers: true }` で `sessionFlags` layer を探す。中に `agents.enabled=false`、`features.multi_agent=false`、`features.multi_agent_v2=false`、`features.guardian_approval=false`、`approvals_reviewer="user"` があるかを見る | 一次資料で確定（実機） |
| feature の実効値 | `experimentalFeature/list` で `multi_agent=false`、`multi_agent_v2=false`、`guardian_approval=false` を確かめる | 一次資料で確定（実機） |
| thread ごとの reviewer と effort | `thread/start` の応答の `approvalsReviewer === "user"`、`reasoningEffort !== "ultra"` | 一次資料で確定（実機） |
| managed policy の強制 | `configRequirements/read` | 一次資料で確定（実機） |
| model に渡す指示に委譲の文言が無いこと | 同じ `CODEX_HOME` と起動引数で `codex debug prompt-input` を回し、`<multi_agent_role>` と `<multi_agent_mode>` が無いことを確かめる。token は使わない | 一次資料で確定（実機） |
| thread の実効 multi-agent 版、tool の一覧 | app-server の応答には出ない。source からは Disabled なら collab tool が登録されないと読める。turn で tool 一覧を見て確かめてはいない | 不明（実機の turn が必要） |
| 実行中に委譲が起きていないか | tripwire として監視する: thread item の `collabAgentToolCall` と `subAgentActivity`、子 thread の `thread/started`（source が `subAgent`）、`item/autoApprovalReview/started`、`autoApprovalReview/strictReviewRequired`、`enteredReviewMode`。どれかが出たら厳密モードの違反として Run を止める | 生成型からの推論 |

`multiAgentMode` は常に `explicitRequestOnly` なので、観測の手段にならない（1.2 を参照）。

## 2. 個人の AGENTS.md と config の MCP server を読ませない

### 2.1 個人の `~/.codex/AGENTS.md`

**一次資料で確定**（source、公式 docs、実機）

- 個人の指示は `CodexHomeUserInstructionsProvider` が `CODEX_HOME` の `AGENTS.override.md` と `AGENTS.md` から読む。空でない最初の 1 つを使う（[`codex-home/src/instructions/mod.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/codex-home/src/instructions/mod.rs)）。app-server は常にこの provider を `config.codex_home` で組み立てる（[`app-server/src/message_processor.rs` L358-360](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/message_processor.rs#L358-L360)）。この読み込みを止める config は無い。
- 公式 docs: 「In your Codex home directory (defaults to `~/.codex`, unless you set `CODEX_HOME`), Codex reads `AGENTS.override.md` if it exists. Otherwise, Codex reads `AGENTS.md`.」「Codex skips empty files.」（[AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)）。空の `AGENTS.override.md` を置いても、次の `AGENTS.md` が読まれるので消せない。
- `baseInstructions` と `model_instructions_file` は、model 組み込みの system 指示を差し替えるだけである（[`core/src/config/mod.rs` L4112-4128](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs#L4112-L4128)）。`developerInstructions` は developer message を足すだけである。実機でダミーの `AGENTS.md` を置いた `CODEX_HOME` を使い、`baseInstructions` と `developerInstructions` を付けて `thread/start` した。応答の `instructionSources` には、その `AGENTS.md` が残った。
- `project_doc_max_bytes=0` で消えるのは、cwd 側の project の `AGENTS.md` だけである。実機では、cwd の `AGENTS.md` は `instructionSources` から消え、`CODEX_HOME` 側は残った。

`CODEX_HOME` を分けるのが唯一の方法である。`CODEX_HOME` は既存の dir を指す必要がある（[`utils/home-dir/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/utils/home-dir/src/lib.rs)）。空の dir で起動すると、Codex は `installation_id`、`skills/`、`tmp/` などを自分で作る（実機）。

project の `AGENTS.md`（cwd から repo root まで）は、`CODEX_HOME` を分けても読まれる。設計書 11.2 の「Codex が自分の環境で読む指示ファイル」として、`instructionSources` を記録すればよい。読ませたくないときは `-c project_doc_max_bytes=0` を使う。

### 2.2 config の MCP server

**一次資料で確定**（source と実機）

- `-c mcp_servers={}` では消えない。config の layer は table を再帰的に merge するので、空の table を上に重ねても下の key が残る（[`config/src/merge.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/merge.rs)）。実機でも `config/read` と `mcpServerStatus/list` に server が残った。
- `-c mcp_servers.<name>.enabled=false` は効く。公式の説明は「Disable an MCP server without removing its configuration.」（config reference）。実機では `enabled:false` になり、起動も試みなかった（`toolsError` が null）。ただし、ユーザーの config にある server の名前を知る必要がある。
- `CODEX_HOME` を分ければ、ユーザーの `config.toml` 自体が読まれない。`config/read` の layer は `sessionFlags`、`user`（分けた home の `config.toml`）、`system` だけになった（実機）。system の `/etc/codex/config.toml` と MDM は `CODEX_HOME` と関係なく読まれる。
- ChatGPT の apps（connector）と plugins は、config ではなく account と feature から来る。厳密モードでは `--disable apps --disable plugins` も付ける。（生成型や help からの推論。source で `Feature::Apps` が connector を止めることは見たが、plugin 由来の MCP は追っていない）

### 2.3 分けた `CODEX_HOME` での ChatGPT 認証

認証の保存先は `CODEX_HOME` に結び付いている。

- file モードでは `$CODEX_HOME/auth.json` に保存する（[`login/src/auth/storage.rs` L162-163](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs#L162-L163)）。公式 docs: 「`file` stores credentials in `auth.json` under `CODEX_HOME` (defaults to `~/.codex`).」（[Authentication](https://learn.chatgpt.com/docs/auth)）
- keyring モードの key は、`CODEX_HOME` の正規化した path の SHA-256 から作る（`compute_store_key`、同じファイルの L246-258）。home を分けると別の entry になり、共有できない。
- `ephemeral` モードは process の memory にしか持たない。
- 認証ファイルの場所を `CODEX_HOME` 以外に向ける config は見当たらない。

選択肢を比べる。

| 方法 | Bridge が認証の中身に触れるか | 確度 | 評価 |
|---|---|---|---|
| A. 分けた `CODEX_HOME` で、ユーザーが一度 `CODEX_HOME=<Bridge 用> codex login` を実行する（device code も可） | 触れない。保存も refresh も Codex CLI が行う | 一次資料で確定 | 推奨。設計書 10.4 に合う。ログインが 1 回増え、refresh token が別系統になる |
| B. 分けた `CODEX_HOME` に `auth.json -> ~/.codex/auth.json` の symlink を張る | 触れない（link を作るだけ）。ただし Codex は symlink の先の `~/.codex/auth.json` を書き換える | 生成型や help からの推論 | 次の項で説明する |
| C. app-server の `account/login/start` で `chatgptAuthTokens` を渡す | 触れる。Bridge が access token を持ち、`account/chatgptAuthTokens/refresh` に答え続ける | 一次資料で確定 | 不可。公式 docs では「experimental and intended for host apps that already own the user’s ChatGPT auth lifecycle」とされている |
| D. `CODEX_ACCESS_TOKEN` / `--with-access-token` | 触れる（token を env で渡す） | 一次資料で確定 | ChatGPT Enterprise の admin が許可した場合に限られる（Authentication docs）。個人の ChatGPT 認証の代わりにはならない |

B について補足する。file storage の保存は `OpenOptions::truncate().write()` で行い、rename を使わない（`storage.rs` L214-231）。このため書き込みは symlink を辿り、元のファイルに届く。また Codex は、同じ auth を複数の process が使う前提で作られている。refresh の前に disk から読み直し、disk の内容が変わっていなければ refresh する（[`login/src/auth/manager.rs` L1850-1862, L2387-2400](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs#L1850-L1862)）。

ここから「既存の daemon や TUI と同じ login を共有できる」と推せるが、この調査では実機で確かめていない。`~/.codex/auth.json` が書き換わる可能性があり、この調査の制約に反するためである。また、ユーザーが keyring モードを使っている場合は、B は使えない。この Mac では `~/.codex/auth.json` が存在した（mode 600。中身は読んでいない）。

A と B のどちらでも、Bridge は env の `CODEX_HOME` を設定するだけで済み、認証ファイルの中身を読み書きしない。`account/read` の応答（account の種類と `requiresOpenaiAuth`）で、login 済みかを確かめられる（実機で、未 login の home が `requiresOpenaiAuth: true, account: null` を返すことを確認）。

## 3. 設計書への反映の候補

- 8.5: 「無効化できるか」の答えは yes。必要な条件は `agents.enabled=false`、reviewer を `user` に固定すること、`review/start` を呼ばないことの 3 つ。`features.multi_agent=false` だけでは足りないことを明記する。
- 10.4: 認証は A（Bridge 専用の `CODEX_HOME` に別途 login）を既定にする。B は互換モードの候補にとどめ、実機で確かめてから採る。
- 11.2: Bridge 専用の `CODEX_HOME` を使うと、個人の `AGENTS.md`、個人の MCP server、plugins、skills、hooks、apps の reviewer 設定がまとめて外れる。cwd 側の project の `AGENTS.md` は残るので、`instructionSources` を記録する。
- G10: 起動直後に 1.5 の確認（`config/read`、`experimentalFeature/list`、`configRequirements/read`、`thread/start` の応答）を行い、満たさなければ厳密モードを拒否する。実行中は tripwire を監視する。

## 4. 未確認のこと

- `agents.enabled=false` のとき、実際の turn で model に渡る tool の一覧に collab tool が無いこと（source からの推論。`prompt-input` で見えるのは入力だけで、tool は出ない）
- B（symlink）で、既存の daemon や TUI と refresh が衝突しないこと
- `request_permissions` の strict auto review（`strict_auto_review_enabled`）が、reviewer を `user` にした状態で guardian を呼ぶことがあるか。turn の権限付与から入る経路で、追い切れていない
- project の `.codex/config.toml`（project layer）が、分けた `CODEX_HOME` で trust の無い状態のときに読まれるか

## 出典

- codex-cli 0.163.0 の `codex --help`、`codex app-server --help`、`codex features list`、`codex debug models`、`codex debug prompt-input`
- `codex app-server generate-ts --experimental` で生成した型: `ThreadStartParams`、`ThreadStartResponse`、`ApprovalsReviewer`、`ReviewStartParams`、`ConfigReadResponse`、`ConfigLayerSource`、`ConfigRequirements`、`ExperimentalFeature`、`LoginAccountParams`、`ChatgptAuthTokensRefreshParams`、`ServerNotification`、`ThreadItem`
- openai/codex の source（tag `rust-v0.163.0`）。本文の各リンクを参照
- 公式 docs: [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)、[AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Authentication](https://learn.chatgpt.com/docs/auth)、[App server](https://learn.chatgpt.com/docs/app-server)（developers.openai.com/codex から 308 で移転している）
