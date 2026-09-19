---
id: L-0013
date: 2026-09-19
task: T-030
category: pitfall
status: new
promoted_to:
promoted_in:
---

# at-least-once のスケジューラで「sending で再発火 → 結果不明」を判定すると、同時重複発火で誤って failed になる

## 事象

T-030 で「`pending → sending` の条件付き更新に失敗し現在 `sending` なら Sent フォルダを確認して `sent` / `failed(unknown-delivery)` にする」を実装したところ、同時 2 発火のテストで 2 本目が「Sent に無い → failed + アラーム」になった。1 本目はまだ SMTP 送信中で Sent に現れていないだけだった。

## 知見

`sending` に遷移した時刻（`updatedAt`）を持ち、鮮度が実行時間上限（Lambda タイムアウト）以内なら「進行中」として何もしない。結果不明の判定は古い `sending` にだけ適用する。Lambda のタイムアウトはこの閾値以下に設定する。SMTP 送信自体の失敗（未送信が確実）は `pending` に戻して再試行に任せ、送信後の後処理失敗は `sent` として再送しない。

## 適用先候補

- .spec/templates/design.md（予約実行の状態遷移テンプレート）
- .spec/design.md 3.3（反映済み）
