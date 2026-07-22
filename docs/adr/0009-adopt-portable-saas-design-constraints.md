---
id: adr-0009
title: ADR-0009 — Next.js SaaS基盤から移植可能な設計制約だけを採用する
status: accepted
updated: 2026-07-22
---

# ADR-0009: 移植可能なSaaS設計制約だけを採用する

| Field | Value |
|-------|-------|
| Status | accepted |
| Date | 2026-07-22 |
| Deciders | Repository owner |
| Author | Codex |
| Supersedes / Superseded by | — |

## Context

ChatChartは `ai-dev-foundation` を直接継承している。一方、
`nextjs-saas-template` にはテナント分離、権限管理、入力検証、エラー秘匿に
関する再利用価値のある設計がある。ただし、同テンプレートは Next.js App
Router、Clerk Organizations、Stripe、Prisma、Cloud SQL、Cloud Run を前提とし、
ChatChartのCloudflare Workers上の認可Gate、独自のID連携、BigQueryと
PostgreSQLを分離したデータ構成とは技術境界が異なる。

2026-07-22時点の `nextjs-saas-template`
（[commit b4da7b6](https://github.com/Yukihide-Mitsuoka/nextjs-saas-template/commit/b4da7b6eb334d0e4b93e552b1c08e3784f1277f2)）にある
[`saas-foundation.md`](https://github.com/Yukihide-Mitsuoka/nextjs-saas-template/blob/b4da7b6eb334d0e4b93e552b1c08e3784f1277f2/docs/architecture/saas-foundation.md)、
`permissions.ts`、`prisma.ts`、`errors.ts` と対応するテストをレビューしたところ、
次の設計はスタックに依存せず移植できる。

- 信頼済みのサーバー側コンテキストからテナントを決定し、通常の機能コードには
  テナントスコープ付きのデータアクセスポートだけを渡す。
- 権限コードをコード管理された有限の語彙とし、テナント固有ロールはその権限を
  組み合わせる。利用者が未知の権限コードを追加することは許可しない。
- 外部入力をインターフェース境界で検証し、検証済みの型だけを内側へ渡す。
- インフラ障害の詳細を外部へ露出させず、インターフェース層で安定したエラーへ
  一元変換する。

ChatChartには既に、PostgreSQL RLSの実証（LOG-0032）、Gateによる認可責務
（LOG-0035）、HTTP境界の入力検証とエラー秘匿（LOG-0036）がある。これらを
別実装で置き換える必要はない。一方、将来のコントロールプレーン実装に同じ制約を
適用することはまだ明文化されておらず、実装者がテナント指定可能な汎用DBクライアント
や、無制限の権限文字列、広域な管理者接続を導入する余地がある。

## Options considered

### Option 1: 何もせず、既存実装と個別判断に任せる

既存コードへの変更は不要だが、設計意図が複数のLOGと実装に分散したままとなる。
今後のコントロールプレーン実装が同じ安全性を再現する保証が弱い。

### Option 2: 継承元を `nextjs-saas-template` に変更する

同テンプレートの変更を継続的に受け取れる。しかし、直接親の技術前提がChatChartと
一致せず、Next.js、Clerk、Stripe、Prismaなど不要な実装の競合面と同期負担が増える。
また、基盤ADR-0004はNext.jsのapplication、authentication、paymentを利用先所有とし、
親の追加hopにはmerge latencyが伴うとしている。異なるstackの選択を継承上の責務へ
変えることは、この境界と運用コストに合わない。

### Option 3: 移植可能な制約だけをChatChartの設計として採用する

有用な安全性を技術選定から分離して取り込み、既存のGate、Executor、RLS設計を
維持できる。採用する制約と対象外を明示できる一方、将来の実装時にChatChart固有の
アダプターとテストを作る必要がある。

### Option 4: 共通SaaS層を新しい継承テンプレートとして抽出する

複数製品に共通化できる可能性はあるが、現時点では安定した共通面と3つ以上の
利用例がない。早期抽象化となり、継承階層と運用負担を増やす。

## Decision

Option 3を採用する。ChatChartの直接の継承元は `ai-dev-foundation` のままとし、
`nextjs-saas-template` のファイルやスタック固有実装は継承・複製しない。代わりに、
次の制約をChatChartのコントロールプレーンおよび新しい外部インターフェースへ適用する。

1. 通常のアプリケーションコードは、サーバー側で確定したテナントにスコープされた
   ポートを使用しなければならない。クライアント入力からテナント境界を決定しては
   ならない。
2. PostgreSQLアダプターは、同一トランザクション・同一接続に設定した
   transaction-localなテナントコンテキストとRLSを使用し、テナント未設定時は
   fail-closedにしなければならない。`ENABLE`と`FORCE`、非所有者の実行ロール、
   `USING`と`WITH CHECK`、テナントを含む複合外部キーというLOG-0032の制約を維持する。
3. テナント横断の特権アクセスは、通常コードから直接importできるグローバルクライアント
   として公開してはならない。migration、identity同期、provisioningなど明示的に承認した
   アダプターだけへ能力として注入し、利用箇所を各 `MODULE.md` とテストで列挙する。
   新しい利用箇所の追加はアーキテクチャレビューを必要とする。
4. 権限コードはコード管理された固定語彙とし、テナント固有ロールはその組み合わせだけを
   保持しなければならない。DB seedまたはmigrationとの一致をテストで検証する。
5. HTTP、Webhook、環境変数などの信頼境界では入力を検証し、検証済みの値だけを
   アプリケーション層へ渡さなければならない。
6. 外部向けエラーは各runtimeのインターフェース層にある一つの変換経路を通し、安定した
   エラーコードだけを公開する。SQL、接続先、credential、内部例外の詳細を公開しては
   ならない。

これらは設計制約であり、Prisma、Clerk、Stripe、Next.js、Cloud SQL、Cloud Run、
`nextjs-saas-template` の既定ロールや請求モデルを採用する決定ではない。また、既存の
GateとExecutorに同じ検証や認可問い合わせを重複追加する決定でもない。

## Consequences

**Positive:**

- 継承関係と現在の技術境界を変えず、SaaSで重要なテナント分離と権限管理の安全性を
  将来の実装へ適用できる。
- 特権アクセスの利用箇所が明示され、通常経路への漏出をレビューとテストで検出できる。
- 権限語彙、入力検証、外部エラーの契約が安定し、実装ごとのばらつきを抑えられる。
- 既に検証済みのRLS、Gate、Executorの実装を再利用し、重複コードを増やさない。

**Negative:**

- 権限語彙とDB seedまたはmigrationの同期テストを保守する必要がある。
- 特権アクセスの新しい利用箇所ごとに文書化、テスト、アーキテクチャレビューが必要になる。
- `nextjs-saas-template` の改善は自動同期されず、必要な設計を今後も個別にレビューする
  必要がある。
- transaction-localなテナントコンテキストを保証できるDBアダプター設計が必要になり、
  コントロールプレーン実装時の自由度が一部制限される。

**Follow-ups:**

- 本ADRの承認後、`docs/system-design.md` のコントロールプレーン設計に本制約を反映する。
- コントロールプレーンmoduleを実装するとき、テナントスコープ付きポート、権限語彙、
  特権アダプターの利用一覧、RLS migrationと回帰テストを同じ変更で追加する。
- 新しい共通テンプレートの抽出は、安定した共通実装が3つ以上で確認できるまで行わない。
- Issue #72で承認後の文書・実装作業を追跡する。
