---
id: usage-ja
title: 使い方（日本語）— 新しいPC / 別アカウント / 新規プロジェクト
updated: 2026-07-16
---

# 使い方（日本語セットアップ手順書）

> English: [usage.md](usage.md) ／ このファイルは人間向けの日本語手順書です（ADR-0002：
> ルール本体は英語、人間向けドキュメントは日本語版を併設可）。内容が英語版と食い違った場合は
> **英語版が正**です。

新しいPCや別のGitHubアカウントで基盤を使うときの手順。**まず2つのシナリオのどちらかを判断**
してください。手順が変わります。

| シナリオ | やりたいこと | 使うもの |
|----------|--------------|----------|
| A | この基盤の上で**新規プロジェクトを作る** | GitHub の **「Use this template」**（`git clone` ではない）|
| B | **この基盤リポジトリ自体**を別マシンで開発継続する | `git clone` |

`git clone` が正解なのはシナリオBだけです。シナリオAでcloneすると、新規プロジェクトにこの基盤の
履歴とプレースホルダが混入します。テンプレート機能を使ってください。

---

## シナリオA — テンプレートから新規プロジェクトを作る

テンプレートリポジトリ化フラグは有効済みなので、1アクション＋短いセットアップで済みます。

### 1. テンプレートから新リポジトリを作成

Web: テンプレートリポジトリを開く → **Use this template** → **Create a new repository**。

CLI（同等）:
```bash
gh repo create <あなたのアカウント>/<新プロジェクト> \
  --template Yukihide-Mitsuoka/ai-dev-foundation \
  --private --clone
cd <新プロジェクト>
```
これで**クリーンな履歴**の新リポジトリがあなたのアカウント配下にできます。

### 2. テンプレートのプレースホルダを置換

カスタマイズ対象はすべて `{{...}}` トークンです。全部洗い出す:
```bash
grep -rn "{{" . --exclude-dir=.git
```
最低限置換するもの: `.ai/mission.md` と `CLAUDE.md` の `{{PROJECT_NAME}}` `{{STACK}}` 等、
`.github/CODEOWNERS` ・`.github/ISSUE_TEMPLATE/config.yml`・
`.github/workflows/template-sync.yml` の `{{ORG}}`、pythonプロファイルを使うなら `{{PACKAGE}}`。

### 3. CODEOWNERS をアカウント種別に合わせて修正

`.github/CODEOWNERS` は既定で**チーム記法**（`@{{ORG}}/maintainers`）です。チームは
**GitHub Organization にしか存在しません**。**個人アカウント**ではユーザー名に置換してください:
```
*   @your-username
```
個人リポジトリにチーム記法を残すと、CODEOWNERS が**黙って無効化**されます
この判定は互換ラッパーの対象外なので、ガバナンス適用前に修正してください。

### 4. Makefile プロファイルを選ぶ

最も近いリファレンス実装をルートにコピーしてスタックに合わせます:
```bash
cp profiles/python-uv/Makefile ./Makefile      # または typescript-node / terraform-gcp
```
正準ターゲット契約は [profiles/README.md](../../../profiles/README.md) を参照。

### 5. GitHub ガバナンスを点検

```bash
python3 scripts/github_governance.py validate --root .
python3 scripts/github_governance.py plan --root . --repo OWNER/REPOSITORY
python3 scripts/github_governance.py audit --root . --repo OWNER/REPOSITORY
python3 scripts/github_governance.py apply --root . --repo OWNER/REPOSITORY \
  --confirm-repo OWNER/REPOSITORY

# 同じplan/apply経路を使う互換入口:
DRY_RUN=1 bash scripts/setup-github.sh OWNER/REPOSITORY
bash scripts/setup-github.sh OWNER/REPOSITORY --confirm-repo OWNER/REPOSITORY
```

`validate` はオフラインで動作し、foundation、`.github/governance/profiles/`内の単一
profile chain、repository policyを自動的に解決します。required checksは単調合成され、
profileとrepository policyはcheckを追加できますがfoundation checkを削除できません。
`plan` と `audit` は認証済みのGET-only
`gh api` を使用し、同じ秘匿化済みJSON比較を出力します。対象branch先端で必要check名が
観測されない場合はdriftとし、無関係なcheckはdriftにしません。`plan` は比較完了時に0、
`audit` はdriftまたは権限不足によるunknown時に1、policy・入力・GitHub読み取りの失敗時には
どちらも2を返します。

`audit`が1で終了した場合の対処は
[GitHubガバナンスのトラブルシューティング](../troubleshooting/github-governance.md)を参照してください。

`apply`の前に`plan`を確認してください。設定を変更するのは`apply`だけで、ローカルの
Administration権限と対象名の完全一致確認が必要です。各操作は再読込で検証されます。
policyはsquash-only mergeを必須化し、Discussionsとsquash commit messageの既定値は
repository overrideで選択できます。setup互換ラッパーは`gh`を直接呼びません。`DRY_RUN`は
`plan`、通常実行は完全一致する対象名を2回要求して`apply`へ委譲し、終了コードも引き継ぎます。

固定スクリプトからの移行では、引数なし形式は廃止され、CODEOWNERSなどの手動設定案内も
ラッパーからは出力されません。上記のとおり対象を明示し、このガイドをチェックリストとして
使用してください。

### 6. ローカルゲート導入 → エージェントに向ける

```bash
make setup                             # 依存導入 + pre-commit フック
```
Claude Code でリポジトリを開けば `CLAUDE.md` を自動で読みます。他のエージェントには
`AGENTS.md` を読ませてください。あとは issue を割り当てるだけ。

テンプレートには参照用の例モジュール（`src/modules/catalog/` ＋ `tests/modules/catalog/`）が
同梱されています。形を真似る（COD-050）か、実コードを書き始めるときに両方削除してください。
いつでも `make doctor` でテンプレートの自己チェック（frontmatter 整合性 + guard フックのテスト）が
できます。

---

## シナリオB — 基盤リポジトリ自体を別マシンにclone

```bash
git clone https://github.com/Yukihide-Mitsuoka/ai-dev-foundation.git
cd ai-dev-foundation
# 素のテンプレートのルート Makefile は no-op なので、ここでは `make setup` は何もしません。
# git フックを直接入れます（pre-commit が必要 — 前提ツール参照）:
pre-commit install --hook-type pre-commit --hook-type pre-push
make doctor                            # テンプレートが壊れていないか検証
```
これは文字通り「cloneするだけ」ですが、各マシンで下記の**前提ツール**と**認証**は一度必要です。

---

## マシンごとの前提ツール（両シナリオ共通）

新しいマシンで一度だけ導入:

| ツール | 用途 | 備考 |
|--------|------|------|
| `git`, `make` | 全般 | — |
| `gh`（GitHub CLI）| ガバナンス`plan`/`audit`/`apply`・互換setup・認証 | `gh auth login` |
| `pre-commit` | ローカルコミットゲート | `make setup`（プロファイル導入後）または `pre-commit install` |
| スタックのツールチェーン | build/test | uv(python) / pnpm+node(ts) / terraform(iac) |
| `gitleaks`, `trivy`, `syft` | ローカルの `make security-scan` / `sbom` | ローカルは任意。**CIは常時強制** |

スキャナはローカル任意です。GitHub Actions が全PRで実行するので、未導入でも「ローカルで結果が
見えない」だけです。

---

## 落とし穴（ぶつかる前に読む）

### push には `workflow` OAuth スコープが必要
`.github/workflows/` 配下を含む push はトークンの `workflow` スコープが必要です。
*"refusing to allow an OAuth App to create or update workflow ... without workflow scope"*
と拒否されたら:
```bash
gh auth refresh -h github.com -s workflow
```
これは**アカウント／マシンごと**の設定です。新環境ごとに一度実施する想定でいてください。

### ソロ開発 × ブランチ保護 ＝ 自分のPRをマージできない
`.github/governance/repository.json`の`required_approvals`をリポジトリ体制に合わせます。
第二のレビュアーなしで1件必須にすると自己マージできません。どちらか選択:

- **推奨（ガードレール維持）:** 共同開発者/レビュアーを1人追加、または AI レビュアー
  （[ai-review.yml](../../../.github/workflows/ai-review.yml)）を有効化。ただしAIのレビューコメントは
  GitHub上の *approval* にはならないため、真の自己マージには下の方法が必要。
- **ソロ実用:** repository policyで`"required_approvals": 0`に設定。
  これでも「ブランチ＋PR＋CI緑」（GR-010, GR-021）は保たれ、マージだけ自分で行えます。

`scripts/setup-github.sh`も同じrepository policyへ委譲するため、直接CLIと互換入口のどちらでも
設定したapproval件数が適用されます。

### 改行コード
`.gitattributes` がリポジトリ全体を LF 強制するので、Windows チェックアウトでもシェルフックと
Makefile は壊れません。グローバル `core.autocrlf=true` でこれと戦わないこと（`.gitattributes` が
対象ファイルでは勝ちますが、Git既定は素直にしておく）。

---

## 質問への回答

### Q. 別アカウントから「Use this template」してよい？ → **可能。1台のPCで完結できます**

テンプレートリポジトリにそのアカウントがアクセスできれば、どのアカウントからでも生成できます。

| テンプレートの公開設定 | 「Use this template」できるアカウント |
|------------------------|----------------------------------------|
| public | 誰でも（あなたの別アカウント含む）|
| private | 読み取り権限を持つアカウント（コラボレーター）／同じ Organization のメンバーのみ |

- 生成先のアカウント／Org はテンプレートのドロップダウンで選べます（テンプレート所有者と別でOK）。
- **結論:** このPC 1台で完結します。アカウントを切り替えて（または同一アカウントで）テンプレート
  → 新リポ生成 → clone → 開発、の流れで複数PCは不要です。
- 秘密情報を含まない基盤なので、再利用が多いなら **public** が最も手軽。厳密に管理したいなら
  **Organization + private** が綺麗です。

### Q. 全リポジトリを束ねる作業ディレクトリへの「グローバル指示」は仕組みとして想定されている？ → **はい（Claude Code の公式機能）**

Claude Code は起動時にディレクトリツリーを遡って `CLAUDE.md` を読み込みます。したがって階層で
グローバル指示を効かせられます（2026-07 時点の公式仕様で確認）:

| スコープ | 場所 | 適用範囲 |
|----------|------|----------|
| 組織管理ポリシー | Linux/WSL: `/etc/claude-code/CLAUDE.md` | マシン上の全セッション・全リポジトリ（個人設定で除外不可）|
| ユーザー | `~/.claude/CLAUDE.md` | あなたの全プロジェクト |
| **束ねる親ディレクトリ** | 例 `~/projects/CLAUDE.md` | **その配下の全リポジトリ**（cwd から親を遡って読む）|
| プロジェクト | `<repo>/CLAUDE.md` ＋ `.ai/` | そのリポジトリのみ（この基盤が提供）|

読み込み順は root 側 → cwd 側で、**cwd に近いものが後に読まれ優先**されやすい。すべて連結して
コンテキストに入ります（上書きではない）。

**推奨する構成:**
- 全リポ共通の「ハウスルール」→ `~/projects/CLAUDE.md`（例: 常に日本語で応答、あなたの名前・役割、
  優先ライブラリ、コミット文体）。**200行以内**に保つ。
- 真に全環境共通 → `~/.claude/CLAUDE.md`。
- 各リポの `.ai/` は**自己完結の正準ルール**のまま（100リポにコピーしても単独で機能し、
  ChatGPT/Gemini でも全ルールが読める）。

**重要な注意:**
- これは **Claude Code 固有**の仕組みです。ChatGPT/Gemini は親/グローバル `CLAUDE.md` を自動では
  読みません。ベンダー中立性のため、**ハードなガードレールは各リポの `.ai/` と PreToolUse フック**
  （この基盤の `guard-bash.sh` がまさにそれ）に置き、グローバル層は「競合しない補助的な好み」に
  留めてください。ハードルールをグローバル層“だけ”に置くと、他所へcloneした/他エージェントが読む
  リポジトリでそのルールが失われます。
- `CLAUDE.md` は「コンテキストであって強制設定ではない」（公式明記）。確実に**ブロック**したい操作は
  PreToolUse フックで実装します。

複数リポで共有したいルール断片は `.claude/rules/` にシンボリックリンクを張る方法も公式サポート
されています（例: `ln -s ~/shared-claude-rules .claude/rules/shared`）。

---

## クイックリファレンス:「別アカウントで clone だけで足りる？」

- **基盤を開発する**（シナリオB）: はい。`git clone` ＋ `make setup` ＋（そのマシンで一度）
  `gh auth refresh -s workflow`。
- **新規プロジェクトを作る**（シナリオA）: いいえ。「Use this template」→ 上の6ステップ。
  cloneでは新規プロジェクトにこの基盤の履歴とプレースホルダが混入します。
