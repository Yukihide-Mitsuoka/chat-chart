# ADR-0006: Run the edge authorization gate on Cloudflare Workers

| Field | Value |
|-------|-------|
| Status | proposed |
| Date | 2026-07-18 |
| Deciders | repository owner |
| Author | Claude (AI agent) |
| Supersedes / Superseded by | — |

<!--
  Note (repo governance): ADR-0002 requires English for docs/adr content. Following the
  LOG-0020 pattern (owner-approved exception for ADR-0005 / discovery-log): kept in
  Japanese while the deciding audience is the Japanese-speaking owner; translate before
  this moves past "proposed" toward formal AI-agent-facing status.
-->

## Context（強制する問題）

ADR-0005は「常時稼働の薄いエッジ認可ゲート」（JWT検証・ctx解決・キー導出・①②③キャッシュ）を前提とするが、ランタイムは「Cloudflare Workers / Vercel Edge」と仮置きのまま（§9）。縦串スパイク（§11・LOG-0031）でゲートのルール群はインプロセス実証済みで、**Phase 1本実装はランタイム未確定がブロッカー**になった。

制約:

- **コスト**: 事業モデルは「小さく黒字」（LOG-0021）。ここはv1で唯一「0円を諦める」と決めた層だが、上限は月数百〜千円台。
- **性能**: コールドスタート不可（顧客向けSLAの入口）。スパイク実測でES256検証~0.25msが床、ゲート自体は薄い。
- **必要機能**: WebCrypto（ES256検証）／TTL付きKV（②結果・③認可・デニーリスト）／①シェルの長期immutableキャッシュ（CDN）。
- **整合性**: デニーリスト伝播は ③TTL=60s と同等以内なら設計上許容（epoch照合が控えにある。ADR-0005 §3③）。
- **運用**: 開発者1名。ローカル開発・CIテストが素直にできること。
- **地理**: 利用者は日本想定。バックエンド（MCP=Cloud Run、BigQuery、Vertex）はGCP `kotonoha-bi-dev`（asia-northeast1想定）。

## Options considered

### Option 1: Do nothing（インプロセスのまま／自前Nodeサーバを常時稼働）

スパイクのgateをNodeサーバとしてVM/コンテナで常時稼働。
- 長所: 追加技術ゼロ、スパイクコードがほぼそのまま動く。
- 短所: 常時稼働VMの運用（パッチ・監視・冗長化）が1人開発の固定費として最悪。エッジでもKVでもCDNでもなく、①②③の置き場を全部自作することになる。**却下**。

### Option 2: Cloudflare Workers ＋ Workers KV ＋ Cache API（推奨）

- 長所:
  - **コスト**: 開発中はFreeプラン（10万req/日）で0円。本番はWorkers Paid **$5/月**に10Mリクエスト・KV・Durable Objects込み — 3〜5社規模では実質固定費$5。
  - **性能**: isolateモデルでコールドスタート実質なし。東京PoPあり。WebCrypto標準搭載（ES256検証はスパイクの床値相当で動く）。
  - **機能適合**: KVはTTL付きで②③デニーリストにそのまま対応。①シェルはCache API/CDNで長期immutable配信。**KVの結果整合（伝播≤60s）は③TTL=60sと同値**で、設計が既に許容している失効モデルと一致。より強い即時性が要る場合は同プラン内のDurable Objects（強整合）へ逃がせる。
  - **運用**: wrangler でローカル開発・デプロイ・CIが完結。実績・情報量が最多。
- 短所:
  - GCPと**マルチクラウド**になる（請求・認証情報・監視が2系統）。
  - ゲート→MCP(Cloud Run)はパブリックインターネット経由（東京PoP→asia-northeast1なので実測影響は小さい見込み。②ヒット時は発生しない）。
  - ベンダーロック: Workers固有API（KVバインディング等）。→ 対策は Decision の分離ルール。

### Option 3: Vercel Edge Functions

- 長所: DXは良い。エッジ実行＋KV(マーケットプレイス経由)も可能。
- 短所: 価格体系がNext.jsアプリのホスティングに最適化されており、素のAPIゲート用途では割高（Pro $20/月/席〜＋Function従量）。KVがファーストパーティでなくUpstash等の外部アドオン。フロントをVercelでホストする予定もない。**同等機能をより高いベンダー分散で買うことになり優位性がない**。

### Option 4: Google Cloud Run（min-instances=1・単一リージョン）

- 長所: **シングルクラウド**（GCP集約、MCP/BigQueryと同居・同一IAM）。日本の顧客だけなら単一リージョンのレイテンシで十分。スパイクのNodeコードがコンテナのままほぼ動く。
- 短所: コールドスタート回避に min-instances=1 が必要で**アイドル課金（月$10-15規模）が$5を超える**。KV/CDN相当が別途要る — Memorystore Redisは月$30超で論外、代替のUpstash等を足すと結局マルチベンダー化して Option 2 の短所だけ再導入する。「エッジKV＋CDN＋実行環境」が単品同梱の選択肢に対し、組み立て部品が多い。

（Deno Deploy / Fastly Compute も一瞥した: 前者はエコシステム・実績で Option 2 に劣後、後者はエンタープライズ寄り価格で対象外。）

## Decision

**エッジ認可ゲートは Cloudflare Workers で実装する**（Option 2）。②結果・③認可・デニーリストは Workers KV、①シェルは Cache API/CDN。開発はFreeプランで開始し、本番投入前に Workers Paid（$5/月）へ切り替える（**プラン契約・支払いはオーナー操作** — CLAUDE.md §13）。

この決定が作るルール:

1. **ゲートのコアはランタイム非依存の純関数群として `src/modules/gate/domain|application` に置き、Workers固有API（KVバインディング・Cache API・fetchハンドラ）は `infrastructure|interface` の薄いアダプタに隔離しなければならない**（MUST）。スパイクのインプロセス実装（Map/node:test）が第二のアダプタとして残り、ARC-005の「seamには現用の第二アダプタ」を満たす＝ロックイン保険とテスト高速化を兼ねる。
2. スパイクの12テスト（`spikes/vertical-slice/test.mjs`）を**受け入れスイートとしてコアに移植**し、コアはNodeのみで（Workersなしで）テスト可能であること（SHOULD）。
3. 剥奪の即時性保証は「デニーリストKV伝播≤60s ＋ ③TTL=60s ＋ epoch照合」の複合とし、**これを上回る即時性が要件化したらDurable Objectsで③を強整合化する**（その時この節を改訂）。

## Consequences

**Positive:**
- 固定費が確定する: 開発0円 → 本番$5/月（10Mreq込み）。「小さく黒字」の原価構造に収まる。
- ①②③の置き場（CDN/KV）がランタイム同梱になり、Phase 1の組み立て部品が最少になる。
- コア/アダプタ分離により、受け入れテストはNodeだけで回り、CIが軽い。

**Negative:**
- マルチクラウド化（Cloudflare＋GCP）: 請求2系統・シークレット2系統・障害ドメイン2つ。監視はまず両者のダッシュボード併用で妥協する。
- KV結果整合により、**剥奪の最悪伝播は~60s**（設計許容内だが、SLAに明記する前提。厳格化はDurable Objects移行が必要）。
- KVの書込は1 key/秒制限 — version-tokenキーはimmutable書き捨てなので抵触しない設計だが、キー設計変更時は再確認が要る。
- ローカル開発にwrangler（miniflare）ツールチェーンが増える。

**Rollback:** コアが純関数のため、アダプタを書き換えれば Cloud Run（Option 4）へ移設可能。KVデータはすべてキャッシュ（SoRはPostgres/BigQuery）なので**移行時に運ぶ状態がない**——ロールバックは「再デプロイ＋DNS切替」で完結する。

**Follow-ups:**
- #23: `src/modules/gate` スキャフォールド（ARC-001レイアウト＋MODULE.md）→ コア移植 → Workersアダプタ → CI。
- オーナー: Cloudflareアカウント作成（Freeで開始。Paid化は本番前に改めて確認）。
- `.ai/architecture.md` のStack/Deploymentへ反映（ADR承認後）。
- ゲート→MCP間の認証方式（サービス間トークン）は `src/modules/gate` 実装時に決める（Local変更の範囲）。
