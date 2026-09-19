# Requirements: {{システム名}}

> 要件は EARS (Easy Approach to Requirements Syntax) で記述する。
> 各要件は一意の ID を持ち、design.md / task.md から参照される。

## EARS 構文リファレンス

| パターン | 形式 |
|----------|------|
| 普遍 (Ubiquitous) | The {{system}} shall {{response}}. |
| イベント駆動 (Event-driven) | WHEN {{trigger}}, the {{system}} shall {{response}}. |
| 状態駆動 (State-driven) | WHILE {{state}}, the {{system}} shall {{response}}. |
| 望まない事象 (Unwanted behaviour) | IF {{condition}}, THEN the {{system}} shall {{response}}. |
| オプション (Optional) | WHERE {{feature is included}}, the {{system}} shall {{response}}. |

日本語で書く場合も構造を保つ:「{{トリガー}}のとき、{{システム}}は{{応答}}しなければならない」。

## 1. 機能要件

### REQ-001: {{要件タイトル}}

- **要件**: WHEN {{trigger}}, the {{system}} shall {{response}}.
- **理由**: {{なぜ必要か。specify.md のどの課題に対応するか}}
- **受け入れ基準**:
  - [ ] {{テストで検証可能な条件 1}}
  - [ ] {{テストで検証可能な条件 2}}

### REQ-002: {{要件タイトル}}

- **要件**: IF {{condition}}, THEN the {{system}} shall {{response}}.
- **理由**: {{...}}
- **受け入れ基準**:
  - [ ] {{...}}

## 2. 非機能要件

### NFR-001: {{性能 / 可用性 / セキュリティ / コスト など}}

- **要件**: The {{system}} shall {{response}}.
- **受け入れ基準**:
  - [ ] {{計測可能な条件}}

## 3. 対象外

- {{今回は満たさないと明示する要件}}

## 4. 未決事項

- [ ] {{ユーザに確認が必要な点}}
