# Supervisor は Mod の寿命に従い、reload で Run を止める

Run の状態機械は Bun の Supervisor process に置き、Mod は hook を Supervisor への command と long poll に翻訳するだけにする。Supervisor は Mod から `$.process.spawn` で起動するので、module の reload と session の終了で host に kill され、その上の app-server と実行中の Run も止まる。初期版は reload で Run が止まることを許容しているので、切り離した Supervisor が要求する lease・heartbeat・孤児の掃除・所有 epoch と、再起動をまたぐ SQLite の永続化を持たない。状態は Supervisor の memory だけに置き、Conversation の再利用も Supervisor の寿命の中に限る。

## Considered Options

- **状態機械を Mod の JS に置く**: Mod は app-server と直接話せず中継 process がどうせ要るうえ、Mod の環境には Bun も SQLite も無く、試すにも Claude Code の実機が要るので退けた。
- **Supervisor を `$.process.run` の bootstrap で切り離す（設計書 v1 の 3.1・12.1）**: reload をまたいで Run を続けられるが、その利点を初期版では使わないので退けた。Mod との通信は HTTP over Unix socket の long poll にしてあるので、後から切り離すときに替わるのは起動方法と、lease と永続化の追加になる。

## Consequences

- Supervisor は Claude Code の異常終了で残らないよう、親 process の消失を自分で確かめて終了する。異常終了時の `$.process.spawn` の子の扱いは型宣言に書かれていない。
- reload の後に、前の Supervisor の Run を持つ worker の Host Step が届くと、新しい Supervisor はその Run を知らないので「reload で停止した」という失敗を返す。
