# PROTOTYPE: Run に指定した model と effort が実際の Codex Turn に届いたことを、どの観測値で確かめるか

捨てる前提の prototype。merge しない。問いと判定は issue [#17](https://github.com/ashigirl96/dawpi/issues/17) にある。

対象の版: codex-cli 0.163.0、Bun 1.4.4（macOS）。Claude Code は介さない。Codex は Bridge 専用の `CODEX_HOME`（`~/.codex-bridge/codex-home`）と Bridge の起動引数で動かす。

## 構成

`probe.ts` が `codex app-server` を stdio で子に持つ。

```sh
bun probe.ts <mock|live>
```

| scenario | すること |
|---|---|
| `mock` | 偽の Responses API（`model_providers.mock`）に向け、Codex が model に送る request の `model` と `reasoning.effort` を記録する。token を使わない。渡し方ごとに、request と、Bridge が読める値（`thread/start` と `thread/resume` の応答、`thread/settings/updated` の通知、`thread/read`、rollout の `turn_context`）を突き合わせる |
| `live` | 本物の provider（ChatGPT の login）で、`model/list` を読み、`gpt-5.6-luna` に「OK と答えて」を流す。未知の model と、catalog に無い effort と、Codex の知らない effort を渡して、どこで弾かれるかを見る |

`mock` の場合分け（1 つの thread で Codex Turn を続ける）:

| case | 渡し方 |
|---|---|
| 1 | `thread/start` に `model` と `config.model_reasoning_effort` を渡し、`turn/start` では何も渡さない |
| 2 | `turn/start` で毎回渡す。途中に何も渡さない turn と `ultra` の turn を挟む |
| 3 | turn の間に `thread/settings/update` で変える（`configure` の `apply: "next-turn"` にあたる） |
| 4 | Codex Turn が model を待っている間に `turn/settings/update` で変える |
| 5 | case 2 の thread を別の接続から `thread/resume` する（何も渡さない、model だけ、model と effort） |
| 6 | Codex Turn が model を待っている間に `thread/settings/update` で変える |

case 4 と 6 は、mock が最初の request を止めている間に client が設定を変え、mock は tool を呼ばせて同じ turn の 2 回目の request を出させる。

## 観測

生のログは `logs/mock.json` と `logs/live.json`。home の path は伏せてある。

### mock（request に載った値と、Bridge が読める値）

| case | request の model / effort | `thread/read` | rollout の `turn_context` | 通知 |
|---|---|---|---|---|
| 1 | M1 / low、M1 / low | 同じ | 同じ | なし |
| 2 turn 1〜3 | M1 / low、M2 / high、M2 / high（何も渡さない turn は前の値が残る） | 同じ | 同じ | 値が変わった turn でだけ `thread/settings/updated` |
| 2 turn 4（`ultra`） | M2 / **max** | M2 / ultra | M2 / ultra | `thread/settings/updated`（ultra） |
| 3 | 更新の後の turn から M2 / high | 更新の直後から M2 / high | 同じ | `thread/settings/updated` |
| 4 | 2 回とも M1 / low | M1 / low | 同じ | `turn/settings/update` は `turn settings updates require the step_model_switching feature`（-32600）で拒否 |
| 5 何も渡さない | M2 / max（最後の値が残る） | M2 / ultra | — | — |
| 5 model だけ | M1 / **medium** | M1 / **null** | M1、**effort の欄が無い** | — |
| 5 model と effort | M1 / low | 同じ | 同じ | — |
| 6 | 2 回とも M1 / low（実行中の turn は変わらない）。次の turn から M2 / high | **更新の直後から M2 / high**（実行中の turn とずれる） | turn 1 は M1 / low | `thread/settings/updated`（M2 / high） |

M1 は `gpt-5.6-luna`、M2 は `gpt-6-luna`。

### live

- `model/list`（`includeHidden: true`）は 9 件。`ultra` を持つのは sol・astra・terra の系統だけで、`gpt-5.6-luna` と `gpt-6-luna` の effort は low〜max。既定の effort は model ごとに違う（astra は low、ほかは medium）。
- 基準（`gpt-5.6-luna` / low）: 完了。11,842 token。`thread/settings/updated` が `{model, modelProvider: "openai", effort: "low"}` で届き、`thread/read` と `turn_context` も同じ。
- **未知の model（`gpt-nope-1`）は、`thread/start` でも `turn/start` でも受け付けられた。** `warning`（`Model metadata for gpt-nope-1 not found. Defaulting to fallback metadata`）の後、provider が 400（`The 'gpt-nope-1' model is not supported when using Codex with a ChatGPT account.`）を返し、Codex Turn は `failed` になった。別の model への置き換えは起きなかった。
- **catalog に無い effort（`minimal`）と、Codex の知らない effort（`banana`）も受け付けられ、thread の設定に保存された。** `thread/settings/updated` と `thread/read` に `minimal` や `banana` が出る。provider が 400 で拒み、Codex Turn は `failed`。provider が受け付ける値（`none`〜`max`）は catalog の一覧（low〜max）と一致しない。
- `model/rerouted`（`fromModel`、`toModel`、理由は `highRiskCyberActivity` だけ）と `model/verification` は、この試験では出なかった。

## 分かったこと

- **Codex Turn ごとの model と effort を返す API は無い。** `Turn` に model と effort の欄が無い。`thread/read` と `thread/start`・`thread/resume` の応答は thread の今の設定で、`thread/settings/updated` は設定が変わったときだけ届く。turn ごとの記録は rollout の `turn_context` だけで、これは app-server の API ではない。
- **thread の設定は、Codex Turn の開始時に取り込まれる。** 実行中に `thread/settings/update` しても、その turn の request は変わらない（case 6）。`thread/read` は直後から新しい値を返すので、turn の後に読んでも、その turn が使った値とは限らない。
- **effort が null のとき、request には catalog の既定値（`gpt-5.6-luna` は medium）が載るが、Bridge が読めるどの値も null か欄なしになる（case 5）。** `thread/resume` に model だけ渡すと、前の effort は捨てられて null になる。
- **`ultra` は Bridge が読める値では `ultra`、request では `max`。** provider 向けの読み替えは Bridge から見えない。
- **app-server は model も effort も検証しない。** 不正な値は thread の設定に残り、provider の 400 で Codex Turn が失敗する。次の turn でも同じ値が使われる。
- **実行中の Codex Turn の model を変える経路は、既定では無い。** `turn/settings/update` は `step_model_switching` feature が要る（case 4）。
