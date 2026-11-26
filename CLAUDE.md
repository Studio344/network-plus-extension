# Project memory

<!-- agentic-rules:begin -->
<!-- Managed by the agentic-rules bundle (platform: claude-code, profile: core). -->
<!-- Do not hand-edit inside this block. Re-copy from the pinned source ref instead. -->

## 常時適用ルール

組織非依存の安全契約、work cycle、validation、evidence は `.claude/rules/agentic-core.md` にあり、
Claude Code が launch 時に自動ロードする。**このファイルから import しない。**
`@` import は working directory の外を指すと承認ダイアログの対象になり、一度拒否すると恒久的に無効化されるため、
安全契約をそこへ依存させない。

### このファイルは Codex からも読まれる

`AGENTS.md` はこのファイルへの symlink である。Codex は `AGENTS.md`、Claude Code は `CLAUDE.md` と
読むファイル名が違うだけで、実体は 1 つ。片方だけ更新して乖離することがない。

上の「常時適用ルール」は Claude Code を前提に書かれている。**`.claude/rules/agentic-core.md` を
launch 時に自動ロードするのは Claude Code だけ**なので、Codex など自動ロードしないエージェントは
作業を始める前に自分でそのファイルを読むこと。パスは `.Codex/` ではなく `.claude/` が正。

bundle が生成する `.agents/` 以下の Codex 用ミラーは使わない。`.claude` を `.Codex` に機械置換した
だけのもので、参照するパスがすべて存在しないため gitignore してある。

## 詳細ルール（Progressive Disclosure。常時ロードしない）

以下は**読み込まない**。表の「いつ読むか」に該当する作業へ入る直前に、その 1 ファイルだけを読む。
すべてこのプロジェクト内の相対パスであり、bundle の配布時に実体がコピーされる。

| いつ読むか | パス |
| --- | --- |
| 実装方針、検証、ブランチ運用、依存、Web スタックの判断に迷った時 | `.claude/knowledge/agentic-rules/agentic-engineering-rules.md` |
| 応答スタイル、自己改善、エンコーディング、MCP の扱いを確認する時 | `.claude/knowledge/agentic-rules/agent-persona-rules.md` |
| 出典付き調査、RAG、ナレッジ検索エージェントを設計・実装する時 | `.claude/knowledge/agentic-rules/agentic-knowledge-system-rules.md` |
| bounded loop、graph/DAG workflow、checkpoint、HITL を設計する時 | `.claude/knowledge/agentic-rules/loop-graph-engineering.instructions.md` |

profile によっては配布されないファイルがある。存在しないパスは無視し、不足を推測で補わない。

<!-- agentic-rules:end -->

## このプロジェクト固有のルール

このプロジェクトだけに効く絶対制約をここに書く。上の共通ルールと重複する一般論は書かない。

- 導入元 ref: タグ `v0.10.1`（commit `19c7bd01f8a4d96d45926e57d09baf841339f412`、bundle `0.10.1` の正式リリース）
- 導入 profile: `codex-improvement` の手動統合。共通正本は `.claude/knowledge/agentic-rules/`、core は `.claude/rules/agentic-core.md`。配布版との対応と差分は `docs/agentic-harness.md`。
- ローカル逸脱: `.claude/knowledge/agentic-rules/agentic-engineering-rules.md` §6.10 から、レビューコメント marker・レビュアー session UUID・repository variables による merge ゲート手続きの bullet 3 件を削除している（#129 で本リポジトリでは廃止済み。merge 可否は branch protection と通常の CI quality gates で判定する）。v0.10.1 でも上流で削除済みのため追加差分はない。更新時も再導入しないこと。

### 両クライアント共通の改善手順

- 主セッションが唯一の統括。専門9役だけを `.codex/agents/*.toml` と `.claude/agents/*.md` で発見する。Claude の Markdown は Codex TOML 内の役割契約への薄い参照であり、統括エージェントを別途起動しない。
- 改善開始時に `docs/agent-feedback.json` の有効指摘を全件読み、[共通ハーネス手順](.claude/knowledge/agentic-rules/docs/codex-improvement-harness.md) に従う。主セッションが受入条件、全9観点の適用性、関連担当、最終検収を持つ。
- 実装前に共通Pythonの `init` → report の計画記入 → `plan` を行う。全有効指摘を受入条件または理由付き対象外へ対応させ、実証拠を `record` → `check` → `finish` で検収する。未確認や古い証拠は合格にしない。
- ネイティブフックは通常の信頼確認後に実発火を確認する。利用できない場合は同じCLIで検証し、自動発火とは区別する。設定・承認・モデルを変更して通さない。
- 導入、更新、指摘の追加・置換、制約の記録方法は [プロジェクト接続手順](docs/agentic-harness.md) を参照する。

### PR マージは承認依頼なしで進めてよい

ユーザーのローカル動作確認は `develop` からの pull が前提のため、**CI green+全ゲート通過を確認した PR は、
都度の承認を求めずマージしてよい**(2026-08-22 ユーザー指示)。マージ後は毎回
`git push origin origin/main:refs/heads/develop` で develop を同期し、作業ブランチを origin/main から再スタートする。
リリース(バージョンを切る・ストアへ出す)は従来どおり明示指示があるまで行わない。

### prettier の対象は許可リストが正

`panel.js`・`tests/panel.test.js`・`tests/ui-contract.test.js` は**意図的に prettier 管理外**
(契約テストがソース原文のインデントごとピンするため)。`prettier --write panel.js` を直接叩くと
約 700 行が再整形されて契約ピンが大量に壊れる(2026-08-22 に実証)。整形の正は package.json の
`format` script の明示リストのみ。管理外ファイルは手整形で周囲の流儀に合わせる。

### changelog の書き方

`docs/CHANGELOG.md` は **1 項目 1 行**。書式は次のとおりで、本文は英語（ファイル本体に合わせる）。

```
- <分類絵文字> **主題** — 何がどうなったかを一言。
  - Why: 必要なときだけ、理由や原因を 1 行。
```

| 絵文字 | 分類 | | 絵文字 | 分類 |
| --- | --- | --- | --- | --- |
| ✨ | 追加 | | ⚡ | パフォーマンス |
| 🐛 | 修正 | | 🔒 | プライバシー・セキュリティ |
| 🔧 | 変更 | | 📝 | ドキュメント |

- **1 項目 200 文字以内**（絵文字はサロゲートペアなのでコードポイント単位で数える）。
- 補足行は**任意・最大 1 行**、`  - ` で始まる**入れ子の箇条書き**、同じく 200 文字以内。
  2 スペース字下げだけの行にしてはならない。CommonMark ではそれが段落の継続と解釈され、
  GitHub 上で本文に連結した 1 行として描画されるため、生ファイルでしか改行が見えない。
- **詳細は commit message と PR に書く。** changelog は「何が変わったか」だけを載せる場所で、
  経緯・調査過程・実装の理由を並べる場所ではない。
- 補足行は `build-release-notes.js` が行頭 `- ` の行しか拾わないため **GitHub リリースノートには載らない**。
  これは意図的で、リリースノートは主題行だけで完結させる。補足行を読みたい読者向けに、
  リリースノート末尾の `Full changelog: docs/CHANGELOG.md` がそのタグの changelog を指している。

**Why:** v1.0.0 は 1 項目 39〜136 文字だったが、v1.12.0 では平均 688 文字・最長 1238 文字まで肥大し、
段落の壁になって要点が読めなくなった（2026-08-27 にユーザー指摘）。

`npm run changelog:check` が**新規に追加された Unreleased 項目だけ**を検査する。既存行は対象外なので、
過去の履歴が後から不正になることはない。

### テスト実行の絶対則

実ブラウザ回帰（`tests/status-summary-browser.test.js` / `tests/mirror-browser.test.js`）は `EDGE_BIN`、
`CHROME_BIN`、既知のインストール先（リモート環境の `/opt/pw-browsers/chromium` を含む）の順に
実行可能なブラウザを探す。見つからなければローカルではブラウザテストを skip するが、
CI（`GITHUB_ACTIONS=true` または `CI` が `false` 以外）では明示的に失敗する。
ローカルで `npm test` が成功しても、ブラウザテストが skip されたなら実ブラウザ回帰は未検証と扱う。

実行前に `git ls-files 'tests/*.test.js'` と `npm --silent test -- --list` の一覧を照合し、
その checkout で期待するスイート数を求める（固定値は使わない）。`npm test` の終了コードに加え、
テストランナーの通過ファイル数が検出数と一致し、スキップが 0 件で、
両ブラウザスイートが `PASS` と表示されることを確認する。出力をパイプするときは事前に
`set -o pipefail` を設定し、`npm test` の失敗を隠さない。

PR のマージ直前に、必須 checks が現在の PR head SHA に対して成功していることを確認する。
結果が古い（目安 24 時間以上前）場合は同じ head SHA で checks を再実行し、再実行分の成功を確認してからマージする。

### リリースとストア再申請

手順は skill `.claude/skills/store-release/SKILL.md`(`/store-release`)に集約してある。リリース・再申請・store-submit の失敗診断はまずそれを開く。
最重要の 1 点だけここに再掲: **store-submit は release イベントでは発火しない**(release.yml が GITHUB_TOKEN でリリースを作るため)。そのため release.yml が新しいリリースを作った回だけ、`workflow_call` で両ストアへの申請を呼ぶ。ストア画像が前回リリースから変わった回は下書き止まり(upload-only)で、画像差し替え後の審査提出と、再試行・status-only・diagnose は workflow_dispatch で起動する。

### ストア申請の資格情報

ストア申請ワークフローは GitHub の `store-submission` environment secrets を使用する。
手元の `.env` や `.env.*`、ブラウザープロファイル、資格情報の共有先は各担当のローカルで管理する。
公開用の `.env.example` に置けるのは変数名とダミー値だけ。
変数名と設定方法は [ストア申請手順](.claude/skills/store-release/SKILL.md) と
[トラブルシューティング](.claude/skills/store-release/references/troubleshooting.md) を参照する。
不一致の調査には値を出力せず、`store:submit -- --diagnose` の指紋を使う。

Chrome の公開ストア ID は `mhidipnhdnonbjkfklcohmnnmfggjlpo`。
Edge の公開ストア ID は `dhmafmhaagefmichhmmkknapalhmlmal`。
Edge Update API の `EDGE_PRODUCT_ID` は公開ストア ID と異なるため、Partner Center で確認する。
README の両ストアリンクは `npm run version:check` で検証する。
