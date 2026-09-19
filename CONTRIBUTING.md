# コントリビューションガイド

Issue と Pull Request を歓迎します。このリポジトリは Spec 駆動開発（`.spec/`）と TDD で進めているので、以下の流れに沿ってください。

## Issue

- バグ報告・機能要望は [Issue テンプレート](https://github.com/hamazlabo/mcp-mail-manager/issues/new/choose) から作成してください。
- 脆弱性は Issue に書かず、[SECURITY.md](SECURITY.md) の手順で非公開に報告してください。
- 大きめの変更（新しいツールの追加、データモデルや認証方式の変更）は、実装前に Issue で方針をすり合わせてください。

## Pull Request

1. リポジトリを fork し、`develop` からブランチを切ります。PR の宛先は **`develop`** です（`main` は CI が昇格させるブランチで、人間は直接変更しません）。
2. 変更にはテストを添えてください。バグ修正は再現テスト、機能追加はその振る舞いのテストが必要です。
3. 振る舞いを変える場合は `.spec/requirements.md` / `.spec/design.md` / `.spec/task.md` も更新してください。設計判断を変える場合は `.spec/adr/` に ADR を追加します（番号は既存の最大値 + 1）。
4. 送信前にローカルで以下を通してください。AWS 資格情報は不要です。

   ```sh
   npm ci
   npm run typecheck
   npm test
   npx cdk synth --context stage=dev --quiet
   ```

5. PR テンプレートの項目を埋めて送ってください。

### レビューとデプロイの流れ

- PR には CI（ユニットテスト + `cdk synth`）が走ります。初めて貢献する方の PR は、メンテナが承認するまでワークフローが実行されません。
- メンテナのレビュー承認と CI 通過でマージできます。
- `develop` にマージされると dev 環境へのデプロイが起動しますが、メンテナが承認するまで実行されません。承認後、正常性テストを通過した commit が `main` に昇格し、本番へデプロイされます。

## 変更の方針

- 求められていない機能・抽象・設定項目を足さない。最小の変更で解く。
- 既存のスタイルに合わせる。無関係な整形やリファクタは別 PR にする。
- 詳細は [CLAUDE.md](CLAUDE.md) と [.spec/README.md](.spec/README.md) を参照してください。

## ライセンス

貢献いただいたコードは、このリポジトリと同じ [MIT ライセンス](LICENSE) で公開されることに同意したものとみなします。
