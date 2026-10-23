# Codex Bridge

Claude Code の会話から、モデルを選べる Codex エージェントへ仕事を委譲し、Codex からさらに Codex へ再帰的に委譲させるための仕組み。

## Language

### 仕事と会話

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

### 構成

**Worker**:
一つの Run を Claude Code の agent として表したもの。その Host Step にはモデルではなく Bridge が答える。
_Avoid_: native agent、subagent（Claude Code の一般の subagent と区別する）

**Supervisor**:
Run の状態を持ち、Codex を動かす Bridge の process。一つの Claude Code session に一つあり、Bridge の Mod と同じ寿命で止まる。
_Avoid_: daemon、中継

### 待ちと報告

**Yield**:
子を待つ間、Worker が自分の agent の turn を終えて寝ること。子や Bell の完了で起こされる。
_Avoid_: sleep、stop

**Bell**:
寝ている Worker を起こすために、Worker 自身が寝る前に起動しておく待ちの command。Supervisor が鳴らすと終わり、その完了で Worker が起きる。
_Avoid_: 呼び鈴（説明の言葉としてのみ使う）、wake-up message

**Report**:
Worker が呼び出し元に一度だけ届ける、Run の結果。親が Codex の Run では、結果本文ではなく受け取りの印だけを届ける。
_Avoid_: handback（auto mode での届け方の名前としてのみ使う）、完了通知

### 守り

**Guard**:
Bridge が Host Step に答えられない Worker に何もさせないための、Claude Code の plugin の hook。Bridge 自身の部品が止まっていても働く。
_Avoid_: AgentSpec.hooks

**Permit**:
Bridge が Worker に出させる tool 呼び出し一つに対する、一回限りの許可。Guard は Permit の無い Worker の呼び出しを通さない。
_Avoid_: allow rule

**Worker Roster**:
Guard が守る Worker の一覧。session の間は Run が終わっても消さない。
_Avoid_: 台帳
