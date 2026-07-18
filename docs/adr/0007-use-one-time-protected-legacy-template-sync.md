# ADR-0007: 保護された旧Template Syncを一度だけ使用する

| 項目 | 内容 |
|------|------|
| ステータス | accepted |
| 日付 | 2026-07-18 |
| 決定者 | repository owner（手順1〜9の実施指示により承認） |
| 作成者 | Codex (AI agent) |
| 置換関係 | ADR-0004を置換せず、materialize未実装期間の一時運用を定義する |

## コンテキスト

ADR-0004はmanifest駆動・ローカル優先の継承を標準とし、書込み可能な旧
Template Syncを既定で無効にしている。現在はmanifestの検証と次コミットの
planまでは実装済みだが、materializeは未実装であり、親の変更を適用するには
手動コピーか旧Template Syncが必要になる。

一方、旧Template Syncの`GITHUB_TOKEN`にはWorkflow更新権限がない。同期対象に
Workflowが含まれるとpushが拒否される。PATまたは専用GitHub Appを追加すれば
回避できるが、今回の一度の同期のために高権限credentialとローテーション境界を
増やすことは、SEC-021とADR-0004の方針に合わない。

制約は、既存のRLS spikeを変更しないこと、親由来の日本語文書配置規則を反映する
こと、すべての変更をPRとCIでレビューすること、定期的な書込み同期を再開しない
こと、Workflowの実行内容を自動上書きしないことである。

## 検討した選択肢

### 選択肢1: 何もしない

materialize実装まで待つ。方針は最も単純だが、必要な親変更が反映されず、今回の
利用先更新を完了できない。

### 選択肢2: Workflows権限を持つPATまたはGitHub Appを追加する

Workflowを含めて自動同期できるが、高権限credential、保管、失効、ローテーション
運用が増える。単発作業に対してblast radiusが大きいため採用しない。

### 選択肢3: Workflowを利用先所有にして旧Template Syncを一度だけ実行する

`.github/workflows/**`を旧同期から除外し、必要なWorkflow変更はレビュー付きPRで
手動反映する。変数は手動実行の直前だけ有効にし、実行後は成否にかかわらず無効へ
戻す。既存tokenの最小権限を維持できるが、二つの反映経路を一時的に運用する必要が
ある。

### 選択肢4: materializeを先に完成させる

ADR-0004の最終形に一致するが、継承エンジンの削除・競合・確認手順まで新たに設計
する必要があり、今回の同期よりscopeとリスクが大きい。

## 決定

選択肢3を採用する。旧Template Syncでは`.github/workflows/**`を利用先所有として
除外し、Workflow更新用のPATまたはGitHub Appを追加してはならない。親で必要となった
`actions/checkout@v6`はすべての利用先Workflowへ手動反映する。

`TEMPLATE_SYNC_ENABLED`は手動dispatchの直前にのみ`true`とし、workflow runが開始
したら`false`へ戻す。生成PRは自動マージせず、Workflow差分がないことと全CI成功を
確認してから通常のsquash mergeを行う。`docs/foundation/**`は親所有として同期し、
その他の`docs/**`は利用先所有を維持する。

## 結果

**良い点:** 高権限credentialを追加せずに今回の親変更を反映できる。定期書込み同期は
無効のままで、Workflowとプロジェクト文書の所有境界も明示される。

**悪い点:** Workflow変更は別途手動移植が必要である。一時的に旧同期とmanifest planの
二経路が存在し、materialize完成まで完全な単一経路にはならない。

**移行とロールバック:** ignore境界とWorkflow更新を先にPRでマージし、変数を一時的に
有効化して一度だけdispatchする。ロールバックは変数を`false`に保ったまま生成PRを
閉じることで完了し、credentialや本番データの移行は発生しない。

**フォローアップ:** ADR-0004のmaterializeを実装した後、この一時運用を廃止する。
