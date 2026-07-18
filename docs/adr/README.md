---
id: project-adr-index
title: プロジェクトのアーキテクチャ意思決定記録
---

# プロジェクトのArchitecture Decision Records（ADR）

このディレクトリには、ChatChartプロジェクト固有の長期的な設計判断を記録します。
基盤から継承する判断は
[基盤ADR](../foundation/adr/README.md) にあり、ここには複製しません。
アーキテクチャ変更では GR-022 と `.skills/architecture.skill.md` に従います。

## 配置と運用

- 新規ADRは連番の `NNNN-kebab-case-title.md` とし、
  [基盤のADRテンプレート](../foundation/templates/adr.md) を使用します。
- 状態は `proposed → accepted | rejected` とし、必要に応じて `deprecated` または
  `superseded by ADR-NNNN` に遷移します。
- 承認済みADRの判断内容は編集せず、新しいADRで上書きします。
- 実装開始前に人がADRのPRを承認します（GR-022）。
- 各ADRを [.ai/decision-log.md](../../.ai/decision-log.md) に記録します。
- 利用先が所有する文書として日本語で記述します。

## 一覧

| # | Title | Status | Date |
|---|-------|--------|------|
| [0005](0005-cache-and-authorization-architecture.md) | Dynamic rendering with layered cache and hybrid claim+revocation authorization | proposed | 2026-07-16 |
| [0006](0006-edge-gate-runtime-cloudflare-workers.md) | Edge authorization gate runtime uses Cloudflare Workers | proposed | 2026-07-18 |
| [0007](0007-use-one-time-protected-legacy-template-sync.md) | 保護された旧Template Syncを一度だけ使用する | accepted | 2026-07-18 |
| [0008](0008-enable-recurring-protected-template-sync.md) | 保護されたTemplate Syncを定期実行する | accepted | 2026-07-18 |

<!-- 新しいプロジェクトADRを末尾に追加する。 -->
