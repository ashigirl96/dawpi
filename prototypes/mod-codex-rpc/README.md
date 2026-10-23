# PROTOTYPE: Mod と codex app-server の双方向 JSON-RPC

捨てる前提の prototype。merge しない。問いと判定は issue [#4](https://github.com/ashigirl96/dawpi/issues/4) にある。

対象の版: Claude Code 2.1.309、codex-cli 0.163.0、Bun 1.4.4（macOS）。Codex は既定の `~/.codex` で、`gpt-5.6-luna` の low、ephemeral thread。

## 構成

```text
Mod (register.ts) ──$.http.fetch(socketPath)──▶ relay.ts (Bun) ──stdio──▶ codex app-server
```

`relay.ts` は `codex app-server` を stdio で子に持ち、起動時に `initialize`（`experimentalApi: true`）を済ませる。Mod には Unix socket 上の HTTP で次を出す。

| path | 役割 |
|---|---|
| `POST /call` | `{method, params}` に id を振って送り、その response を返す |
| `GET /events?after=N&waitMs=M` | cursor より後の通知と server request を返す long poll |
| `POST /send` | 生の JSON-RPC message を書く（server request への応答） |
| `GET /health`、`POST /shutdown` | 状態と停止 |

`bootstrap.sh` は relay を `nohup` で切り離して起動し、socket が応答したら返る。

## 動かし方

```sh
claude --plugin-dir "$PWD/prototypes/mod-codex-rpc/mod" --model haiku
```

main の Claude に `mcp__cbp4__probe` を呼ばせる。ログは `/tmp/cbp4/log.json` に書かれる。

| mode | 動き |
|---|---|
| `direct` | `codex app-server --listen unix:///tmp/cbp4/c.sock` を起動し、Mod から直に `$.http.fetch` で `initialize` を POST する（対照） |
| `spawn` | relay を `$.process.spawn` で起動し（Mod の寿命）、`$.agent.spawn` で worker を起こす |
| `detached` | relay を `$.process.run` で `bootstrap.sh` 経由で切り離して起動し、worker を起こす |
| `stop` | 2 つの relay に `/shutdown` を送る |

worker（`cbp4:worker`、description が `cbp4 spawn` か `cbp4 detached`）の `turn.step` は、Host Step 0 で 1 回の Codex Turn を流す。Codex に dynamic tool `cbp4_echo` を呼ばせ、Mod が `pong-<nonce>` を返し、Codex の最終 message に nonce が入っていれば `matched: true`。auto mode では `$.agent.spawn` が拒否されるので、main の Claude に `Agent` tool で worker を起こさせる。

## 観測

`logs/run.json` が生のログ（3 つの mode を 1 session で流した）。

- `direct`: `$.http.fetch` は 2 ms で `ECONNRESET`。app-server の Unix socket は WebSocket の Upgrade にしか応じない（curl で `101 Switching Protocols`、plain な GET/POST と生の JSON 行は無応答で切られる）。
- `spawn`: relay は起動し、Codex Turn は約 4.7 秒で完了、`matched: true`。1 回の `turn.step` の中で約 20 秒待ち、予算の消費は 2 ms（`next.budget.remainingMs` 10000 → 9998）。server request（`item/tool/call`）を long poll で受け、`/send` で答えて turn が続いた。15 秒の空振りの long poll も切れなかった。`usage` は `null`。
- `detached`: `$.process.run` は 260 ms・exit 0 で返り、relay は ppid 1 で残った（process group は Claude Code と同じ）。1 つの relay の上で 2 つの worker の Codex Turn が並行し、両方 `matched: true`。
- relay を SIGKILL すると、子の `codex app-server` は stdin の EOF で 2 秒以内に終わった。Mod の spawn の loop も終わりを観測した。
- `$.http.fetch` の `socketPath` は、1 session の中で 3 つの別の path（`c.sock`、`s.sock`、`d.sock`）に使えた。
- auto mode では、Mod の `$.agent.spawn`（`tool.call` hook の中）が classifier に拒否された（「the request that produced this action did not ask for one」）。manual mode では通った。
- auto mode で worker が text で答えて `end_turn` しても、main には届かなかった。engine は Host Step 1〜3 で worker を起こし直し、最後に「SubagentHandback で報告しなかったので届けない」として終えた。manual mode では text がそのまま main に届いた。
