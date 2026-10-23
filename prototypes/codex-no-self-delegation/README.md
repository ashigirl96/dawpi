# PROTOTYPE: Bridge の起動設定で Codex 自身の委譲が起きないか

捨てる前提の prototype。merge しない。問いと判定は issue [#9](https://github.com/ashigirl96/dawpi/issues/9) にある。

対象の版: codex-cli 0.163.0、Bun 1.4.4（macOS）。Claude Code は介さない。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）を使う。

## 構成

`probe.ts` が `codex app-server` を stdio で子に持つ。起動引数は 2 通りある。

| profile | 起動引数 |
|---|---|
| `bridge` | `-c agents.enabled=false --disable multi_agent --disable multi_agent_v2 --disable guardian_approval --disable apps --disable plugins -c approvals_reviewer="user"` |
| `open`（対照） | `-c agents.enabled=true --enable multi_agent`（`CODEX_HOME` の `config.toml` の値を上書きして、委譲を有効に戻す） |

`thread/start` には常に `approvalsReviewer: "user"` を送る（`reviewer` の一部の場合を除く）。

`tools`・`forced`・`reviewer` の scenario は model を mock にする。`probe.ts` の中で Responses API の偽物を `Bun.serve` で立て、custom の model provider（`model_providers.mock`、`wire_api="responses"`）でそこに向ける。Codex が model に送る request をそのまま記録できる。provider は OpenAI の認証を要求しないので、認証情報は mock に届かず、token も使わない。

```sh
bun probe.ts <tools|forced|reviewer|checks|live>
```

| scenario | すること |
|---|---|
| `tools` | profile × model（`gpt-5.6-luna` は catalog で v1、`gpt-6-luna` は v2）× effort（`low`、`ultra`）で、委譲を誘う依頼を 1 回流す。model に渡る tool と developer message を記録する |
| `forced` | mock の model に、渡されていない `spawn_agent` を 3 通りの名前（`collaboration.`、namespace なし、`multi_agent_v1.`）で呼ばせ、続けて `wait_agent` を呼ばせる |
| `reviewer` | `approvalPolicy: "on-request"` で、mock の model に `exec` から昇格の要る `exec_command` を呼ばせる。client への承認依頼はすべて decline する |
| `checks` | turn を流さずに、`config/read`（layer つき）、`experimentalFeature/list`、`configRequirements/read`、`thread/start`、`mcpServerStatus/list` を読む |
| `live` | 実際の model で、委譲を誘う依頼を low で 1 回流す。`bridge` × `gpt-5.6-luna`、`bridge` × `gpt-6-luna`、`open` × `gpt-6-luna` |

`logs/<scenario>.json` が生の log。`logs/tools-requests.json` は、`tools` で mock が受けた request の全文。

tripwire として、次のものを数える: `collabAgentToolCall`・`subAgentActivity`・`enteredReviewMode`・`exitedReviewMode` の item、`item/autoApprovalReview/*`、`autoApprovalReview/strictReviewRequired`、source が `subAgent` の `thread/started`。

## 観測

- Codex は tool を request の top-level の `tools` ではなく、`input` の先頭の `additional_tools` item（role は developer）で送る。code mode の `exec` から呼べる tool は、`exec` の description に `` ### `name` `` の見出しで並ぶ。
- `tools`: `bridge` では、v1・v2 の model と low・ultra のどの組み合わせでも、collab の tool は top-level にも `exec` の中にも無い。developer message に `<multi_agent_role>` と `<multi_agent_mode>` も無い。rollout の `session_meta` と `turn_context` の `multi_agent_version` は `disabled`。`open` の v2（`gpt-6-luna`）には `collaboration` namespace の `spawn_agent`・`wait_agent`・`send_message`・`followup_task`・`interrupt_agent`・`list_agents` と 2 つの tag が載る。`open` の v1（`gpt-5.6-luna`）は rollout では `v1` だが、collab の tool は request に出ない（v1 の tool は `Deferred` で登録され、この構成には tool_search が無い）。
- `ultra` は model への request では `reasoning.effort: "max"` になった。`bridge` では、ultra でも委譲の tool と tag は現れない。
- `forced`: `bridge` では、3 通りの呼び方のどれも `unsupported call: <namespace><name>` が model に返り、子の agent への request は 0 回で、tripwire も出なかった。`open` では `collaboration.spawn_agent` で子の thread が実際に起動し、`{"task_name":"/root/lister"}` が返った。そのとき `subAgentActivity` と `collabAgentToolCall` の item が出た。source が `subAgent` の `thread/started` は、この client には届かなかった。
- `reviewer`:
  - `bridge`（thread の reviewer は `user`）: client に `item/commandExecution/requestApproval` が来た。decline すると、model には `Rejected("rejected by user")` が返った。
  - `bridge` の起動引数のまま、thread にだけ `approvalsReviewer: "auto_review"` を送った場合: `--disable guardian_approval` があっても guardian に回り、`item/autoApprovalReview/started` と `item/autoApprovalReview/completed` が出た。client には承認依頼が来ない。起動引数は guardian を止めない。
  - 対照（guardian を有効にして `auto_review`）も同じ動きだった。どの場合も、mock の guardian の答えが不正な JSON だったので、command は実行されなかった。
- Unix では、requirements（`allowedApprovalsReviewers` など）は system の `/etc/codex/requirements.toml` と MDM からしか読まれない。managed config も system の path にしか置けない（0.163.0 の `config/src/loader/layer_io.rs` の `managed_config_default_path`、`config/src/loader/local.rs` の `local_requirements_layers`）。`CODEX_HOME` の中に置いて reviewer を強制する方法は無い。
- `checks`: `config/read` の実効値と `sessionFlags` layer、`experimentalFeature/list` の値で、`bridge` と `open` を見分けられる。`thread/start` の応答はどちらも同じ（`multiAgentMode` は常に `explicitRequestOnly`）で、見分けには使えない。`configRequirements/read` の `requirements` は `null`、`mcpServerStatus/list` は空、`instructionSources` は `[]`。
- `live`: `bridge` では、`gpt-5.6-luna` と `gpt-6-luna` のどちらも tool を 1 つも呼ばずに `NO_AGENT_TOOLS` と答え、tripwire は 0 件だった（約 12K token ずつ）。挙げた tool に collab のものは無い。`gpt-5.6-luna` は `image_gen.imagegen` と `web.run` も挙げた。`open` の `gpt-6-luna` は `collaboration.spawn_agent`（`fork_turns: "all"`）と `wait_agent` を呼び、子が file の一覧を返した（71K token）。
