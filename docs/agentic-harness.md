# Network+ の改善ハーネス接続

## 正本と固定版

共通ルールの正本は `.claude/knowledge/agentic-rules/`、常時適用 core は
`.claude/rules/agentic-core.md`。`.codex/knowledge/agentic-rules` と同ディレクトリ内の
`agentic-core.instructions.md` は相対 symlink で同じ実体を参照する。
`AGENTS.md -> CLAUDE.md` を維持し、既存のプロジェクト指示・リリース制約を優先する。

基礎の固定版は bundle 0.10.0 の PR #31 draft。元 manifest の41件のチェックサムを照合し、18件の
asset を手動統合した。`.agentic-rules.lock.json` の commit と manifest SHA-256 はこの基礎版を識別し、
各 asset の SHA-256 は実際の保存先のバイト列を記録する。
[基礎の固定版](https://github.com/himiyosh/agentic-rules/tree/a0248b7a876de1ddaa21fea5569b08ed7d94fe0f)

片付けルールは、agentic-rules のマージコミット `f9c2a817bdaeffc80bab6bb0a90e0b2ba09a5168` を
基礎版に追加で適用した。常時適用 core の全体と、engineering の §3.5 が同コミットの内容に一致する。
lock の該当2件は適用後のバイト列を示し、残り16件は基礎版と一致する。
[片付けルールの適用元](https://github.com/himiyosh/agentic-rules/commit/f9c2a817bdaeffc80bab6bb0a90e0b2ba09a5168)

配布版からの意図した差分:

- `AGENTS.template.md` で上書きせず、既存CLAUDE.mdへ参照と手順を追加した。
- `improvement_orchestrator.toml` は置かない。主セッションだけが統括し、同時子担当は最大3。
- 共有 knowledge の保存先を既存の `.claude` に統一した。片付けルールを適用した2件の出典は前段に記録する。
- Codexの9役TOML、hooks.json、Pythonハンドラーは固定元と同一。
- Claudeの9役Markdownは同名のCodex TOML内 `developer_instructions` を読む薄いadapter。
  Claudeの名前はハイフン、Codexはアンダースコア。同じ役割契約を複製しない。
- Claude設定はCodexから `SessionStart` / `UserPromptSubmit` / `Stop` のcommandとtimeoutだけを取り込む。
  `commandWindows` と `statusMessage` はコピーせず、SubagentStopは追加しない。
  既存settingsの他のキー・handlerを保持する。検証ロジックは `.codex/hooks/codex_harness.py` 一つ。
- モデル・provider・tools・承認policy・個人設定を指定しない。roleのread-only指示は権限分離の保証ではない。
- engineering §6.10の廃止済みmarker/session UUID/repository-variable merge gateは固定元にも無く、再導入しない。

## 使い方と指摘の保守

詳細な正本は [共通手順](../.claude/knowledge/agentic-rules/docs/codex-improvement-harness.md)。
実在するコマンドは `python3 .codex/hooks/codex_harness.py --help` で確認する。
開始時に `docs/agent-feedback.json` の有効項目を全件読む。出典は確認済みの制約だけを登録し、
PRODUCT/DESIGNやCLAUDE.mdに詳細がある場合は参照する。

1. `feedback-add --repo . --id <stable-id> --rule '<短い制約>' --source '<確認した出典>' --scope '<範囲>'` で追加する。
2. 競合する指摘は出典と現行要件を照合してから判断する。撤回・変更は元項目を消さず、新IDと `--supersedes <old-id>` で履歴を保持する。未合意案は有効指摘にしない。
3. `init` で要件とrunを作り、reportのplanを記入して**実装前**に `plan` を登録する。全有効IDを要件または具体的な対象外理由へ対応させる。
4. 関連担当だけに独立レビューを依頼し、実行した結果を `record` で登録する。計画改訂は理由を残し、変更によって古くなった証拠を再検証する。再利用は同一性の根拠を明記する。
5. `check` は記録の整合性検査であり、テストの代行や証拠内容の保証ではない。統括が実結果を確認して `finish`。制約で未確認なら理由と次の担当を残して `pause` し、合格に置き換えない。

run/reportはGit metadata内に置かれ、コミットされない。指摘JSONはプロジェクトの追跡対象。
導入の合否と製品変更の合否は別runで管理する。完了はpush/merge/releaseへの新規許可ではない。

## 環境と有効化

公式installerはPython 3.11+、Git、gh、jq、Bashを要求する。今回はmacOSのPython 3.9.6で
固定PythonハンドラーのCLIを使い、checksumを照合したassetを手動統合した。
この実績は公式installerの最低要件を引き下げるものではない。

ネイティブ確認は対象repoをcwdとして開き、Codexの `/hooks`（desktopはReview hooks / Settings > Hooks）、
Claudeの通常のプロジェクト信頼画面と `/hooks` / `/agents` で確認する。
新規/変更hookは通常の信頼確認が必要。信頼registry編集、信頼回避オプション、権限緩和は使わない。
実際のclient版・cwd・sessionと3イベントの発火を記録する。配置・構文検査・模擬入力・ネイティブ発火は別の証拠。
未信頼、認証不足、未対応で動かなければCLI検証と独立レビューを進め、未確認範囲を報告する。
bounded retry後にStopが停止を許しても、品質合格を意味しない。

更新時は新しい固定manifestを別の作業領域で検証し、lockとの差分を確認する。
片付けルールの取り込み状況も比較し、既存リンク、プロジェクト指示、Claude設定、役割adapterの参照先を揃える。
共通機能の不足は上流への候補として整理し、Network+へ検証ロジックを複製しない。

仕様参照: [Codex hooks](https://learn.chatgpt.com/docs/hooks)、
[Codex agents](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app)、
[Claude hooks](https://code.claude.com/docs/en/hooks)、
[Claude subagents](https://code.claude.com/docs/en/sub-agents)。
