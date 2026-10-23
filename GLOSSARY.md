# Codex Bridge

Claude Code の会話から、モデルを選べる Codex エージェントへ仕事を委譲し、Codex からさらに Codex へ再帰的に委譲させるための仕組み。

## Language

**Run**:
一回の委譲された仕事。親 Run を持ち、完了したら再び実行中には戻らない。
_Avoid_: Job, Task, セッション

**Conversation**:
再利用できる Codex の会話。完了後の追加依頼は、新しい Run が同じ Conversation を再利用する形で表す。
_Avoid_: Thread（Codex の実装上の名前としてのみ使う）

**Codex Turn**:
Conversation の中で Codex が一回応答を返すまでの単位。一つの Run は複数の Codex Turn を含みうる。
_Avoid_: Turn（単独で使わない）

**Host Step**:
Claude Code が agent ごとにモデルの応答を一回求める単位。Bridge はモデルの代わりにこれへ応答する。
_Avoid_: Turn（単独で使わない）、step
