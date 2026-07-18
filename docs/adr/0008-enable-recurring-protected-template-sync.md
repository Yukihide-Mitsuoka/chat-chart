# ADR-0008: 保護されたTemplate Syncを定期実行する

| 項目 | 内容 |
|------|------|
| ステータス | accepted |
| 日付 | 2026-07-18 |
| 決定者 | repository owner |
| 作成者 | Codex (AI agent) |
| 置換関係 | ADR-0007を置換し、ADR-0004の「旧定期同期を無効」の部分だけを更新する |

## コンテキスト

ADR-0004は、旧Template SyncでWorkflow更新が拒否されること、`.gitignore`などの
利用先ファイルが上書きされること、未知パスと巨大PRを安全に扱えないことを理由に、
manifest駆動・ローカル優先を標準とした。文書言語の競合だけが無効化理由ではない。

その後、次の安全境界を実装した。

- `.github/workflows/**`と`.gitignore`は利用先所有であり、旧同期から除外される。
- `docs/**`は利用先所有のまま、`docs/foundation/**`だけが親から同期される。
- 利用先固有の`docs/**`は日本語、基盤所有文書は英語という言語規則が明文化された。
- 同期PRは自動マージされず、通常の必須CIとレビューを通る。

ADR-0007に基づく一度限りの実行では、親差分のbranch作成とpushまでは成功したが、
GitHub ActionsによるPR作成を許可しないrepository設定によりPR作成だけが失敗した。
`TEMPLATE_SYNC_ENABLED=true`だけでは定期同期は完成しない。

GitHubの設定
[`Allow GitHub Actions to create and approve pull requests`](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
はPR作成を可能にする一方、Actionsによるapprovalも許可する。GitHub公式REST API文書も
`can_approve_pull_request_reviews=true`をセキュリティリスクとして明記している。

現在のrepositoryは、既定`GITHUB_TOKEN`権限が`read`、branch protectionの必須approvalが
0、admin bypassが無効、必須status checksが有効である。`pull-requests: write`を明示する
のはAI review、release-please、Template Syncの3ジョブだけであり、AI reviewはpromptで
comment-onlyかつapprove/merge禁止、同期とrelease PRも自動マージしない。

## 検討した選択肢

### 選択肢1: 定期同期を無効のまま維持する

必要時に人がworkflowをdispatchし、pushされたbranchから手動でPRを作る。権限は最小だが、
更新検知とPR作成が人の作業に依存し、利用先への伝播が遅れる。

### 選択肢2: 変数だけを有効にする

`TEMPLATE_SYNC_ENABLED=true`にするが、ActionsによるPR作成設定は無効のままにする。
毎週branch push後のPR作成で失敗することが確認済みであり、赤い定期処理を作るため採用しない。

### 選択肢3: repositoryのPR作成設定と定期同期を有効にする

既定tokenは`read`のまま維持し、PR書込みは明示した3ジョブだけに限定する。全Workflowと
プロジェクト文書の所有境界、必須CI、no-auto-mergeを補償統制とする。定期伝播が完成するが、
repository設定上はActionsによるapprovalも可能になる。

### 選択肢4: PATまたは専用GitHub Appを追加する

repository全体のActions PR設定を変えずに同期専用credentialを使用できる可能性があるが、
secret保管、失効、ローテーションと追加の攻撃面が生じる。今回の目的には過剰である。

### 選択肢5: manifest materialize完成まで待つ

ADR-0004の最終形に最も一致するが、materializeは未実装であり、定期伝播の再開時期が未定になる。
完成後の移行先として維持するが、現在の解決策にはしない。

## 決定

選択肢3を採用する。次の条件をすべて維持しなければならない。

1. repositoryの`default_workflow_permissions`は`read`を維持する。
2. `can_approve_pull_request_reviews=true`と`TEMPLATE_SYNC_ENABLED=true`は一体の設定として
   変更し、片方だけ有効な不完全状態を残さない。
3. `.github/workflows/**`、`.gitignore`、プロジェクト固有パスは旧同期から除外する。
4. 同期PRを自動approveまたは自動mergeしてはならず、必須status checksをすべて通す。
5. Workflowに新たな`pull-requests: write`を追加する変更、approval数を1以上へ変更する場合、
   またはActionsからapprovalを送る実装を追加する場合は、この決定を再レビューする。
6. PATまたは追加GitHub Appを導入しない。

ADR-0004のmanifest駆動・直接親・所有権モデルは長期方針として維持する。ADR-0008は、現在の
旧同期を安全境界内で定期transportとして再有効化する部分だけを置換する。

## 結果

**良い点:** 親の非Workflow変更が毎週レビュー可能なPRとして伝播する。利用先の日本語文書、
Workflow、`.gitignore`は上書きされず、追加credentialも不要である。release-pleaseも意図した
PR作成が可能になる。

**悪い点:** GitHubのrepository設定上、明示的にPR writeを持つActionsはapprovalを送れるように
なる。未知の親パスは同期PRへ現れるため、人とCIによるレビューは引き続き必須である。

**移行とロールバック:** 承認後にrepository Actions設定を変更し、read既定を再確認してから
`TEMPLATE_SYNC_ENABLED=true`へ変更する。手動dispatchでPR作成まで確認する。ロールバックは
変数を`false`、`can_approve_pull_request_reviews=false`へ戻す。repositoryデータやcredentialの
移行はない。

**フォローアップ:** manifest materializeが完成したら旧同期との比較を行い、単一transportへ
統合する。定期監査ではActions workflow permissionと変数値を確認する。
