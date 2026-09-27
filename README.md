# satellite

Google Workspace CLI（gws）を介して外部サービス（タスク管理・カレンダーなど）と連携し、ユーザーの状況を踏まえた提案を行う AI Assistant CLI ツールです。

> **Status**: 構想・設計段階。本READMEは実装前の企画書的な位置づけです。

## 目次

- [概要](#概要)
- [背景・モチベーション](#背景モチベーション)
- [コンセプト](#コンセプト)
- [アーキテクチャ](#アーキテクチャ)
- [技術スタック](#技術スタック)
- [セットアップ](#セットアップ)
- [設定](#設定)
- [ロードマップ](#ロードマップ)
- [ライセンス](#ライセンス)

## 概要

satellite は、LLM を中核に据えつつ、タスク管理サービスやカレンダーサービスといった外部ツールを **gws CLI 経由で** 利用する AI Assistant です。単なる「AIからカレンダーを操作できるツール」ではなく、複数のサービスから取得した情報を組み合わせて状況を理解し、次に取るべき行動を提案することを目指します。

例えば、以下のような情報を統合し、

```
Tasks
├─ 論文Aを読む
├─ 実験結果をまとめる
└─ 発表資料を作る

Calendar
├─ 10:00 会議
├─ 14:00 授業
└─ 16:00 空き時間
```

「14:00〜16:00に実験結果の整理を行う」といった、タスクとスケジュールを組み合わせた提案を行います。

## 背景

タスク管理とカレンダーは別々のサービスで管理されていることが多く、両者を突き合わせて「今何をすべきか」を判断するのはユーザー自身の頭の中で行われがちです。この構想では、その突き合わせと提案を AI Assistant に肩代わりさせることを目指します。

## コンセプト

```
LLM + Tool利用(gws) + 状況理解 + Planning
```

- **特定サービスに依存しない**: タスク管理・カレンダーそれぞれについて、具体的なサービス（Google Tasks / Todoist / Google Calendar など）を共通インターフェースの背後に隠蔽する。
- **特定LLMに依存しない**: LLM 呼び出し部分も抽象化レイヤーを設け、Provider を差し替え可能にする。
- **既存資産の活用**: 外部サービスとの通信は既存の公開実装（Google 公式の Google Workspace CLI など）を再利用し、自作は最小限に留める。

## アーキテクチャ

```
                    AI Assistant (CLI)
                         │
                       LLM
                    (Provider抽象化)
                         │
        ┌────────────────┴────────────────┐
        ▼                                  ▼
   Task Interface                   Calendar Interface
   (サービス抽象化)                   (サービス抽象化)
        └────────────────┬────────────────┘
                         ▼
                      gws連携層
            (Google Workspace CLI を都度起動)
                         │
        ┌────────────────┴────────────────┐
        ▼                                  ▼
   Google Tasks                     Google Calendar
   (複数アカウント)                   (複数アカウント)
```

- **AI Assistant (CLI)**: ターミナルから対話する形式のエントリポイント。
- **LLM layer**: 特定モデルに依存しない抽象化レイヤー。初期実装は Gemini を対象とする。
- **gws連携層**: `bunx @googleworkspace/cli`（gws）を呼び出しごとに起動し、Google Tasks / Google Calendar にアクセスする層。アカウントごとに設定ディレクトリを分け、複数アカウントの予定・タスクをまとめて取得する。
- **Task / Calendar Interface**: 個別サービスの違いを吸収する抽象化層。MVP では Task・Calendar の両方を対象とする。

## 技術スタック

| 項目 | 選定 |
|---|---|
| 言語 | TypeScript |
| ランタイム / パッケージ管理 | Bun |
| 外部連携 | Google Workspace CLI（`@googleworkspace/cli`） |
| LLM (初期対応) | Gemini |
| 実行形態 | CLI |
| 想定利用者 | 個人利用 |

## セットアップ

```bash
git clone https://github.com/<your-account>/satellite.git
cd satellite
bun install
cp .env.example .env
# .env に APIキーと OAuth クライアント JSON のパスを設定
mkdir -p ~/.config/satellite
cp google_config.json.example ~/.config/satellite/google_config.json
# google_config.json に利用するアカウントを設定
# （任意）作業時間を変更する場合
cp schedule_config.json.example ~/.config/satellite/schedule_config.json

# アカウントごとに一度だけ認証する（ブラウザで OAuth を承認）
bun run src/cli/auth.ts <account>

# 動作確認
bun run src/cli/calendar_check.ts 7
bun run src/cli/tasks_check.ts

# 実行
bun run src/index.ts 今週の予定とタスクを教えて
```

OAuth クライアント JSON は、Google Cloud Console で作成した「デスクトップ アプリ」の OAuth クライアント（`installed` 形式）をダウンロードしたものを使います。

## 設定

APIキーおよび OAuth クライアントのパスは環境変数 (`.env`) で管理します。

```env
# LLM
GEMINI_API_KEY=

# Google Cloud Console からダウンロードした OAuth クライアント JSON の絶対パス
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json
```

利用する Google アカウントは `~/.config/satellite/google_config.json` で設定します（`google_config.json.example` を参照）。

```json
{
  "oauthClientFile": "${GOOGLE_OAUTH_CREDENTIALS}",
  "accounts": [
    "personal",
    {
      "name": "school",
      "calendarIds": ["your-shared-calendar-id@group.calendar.google.com"],
      "taskListIds": ["your-task-list-id"]
    }
  ]
}
```

- `accounts`: 1 件以上必須。文字列はアカウント名のみ（primary カレンダーと既定のタスクリストを使用）、オブジェクトでは追加のカレンダー ID（`calendarIds`）やタスクリスト ID（`taskListIds`）を指定できる。共有カレンダーは、それを所有・購読しているアカウントの下に書く。
- `gwsCommand`（任意）: gws の起動コマンドを argv 配列で上書きする（既定は `["bunx", "@googleworkspace/cli@0.22.5"]`）。
- 認証情報はアカウントごとに `~/.config/satellite/gws/<account>/` に保存される。

タスク作成時の期日提案で使う作業時間は `~/.config/satellite/schedule_config.json` で設定します（`schedule_config.json.example` を参照）。ファイルがない場合は平日 9:00〜18:00 として扱います。

```json
{
  "workingHours": {
    "mon": [{ "start": "09:00", "end": "12:00" }, { "start": "13:00", "end": "18:00" }],
    "sat": [],
    "sun": []
  }
}
```

- `workingHours`: 曜日（`mon`〜`sun`）ごとに作業時間帯を `"HH:MM"` 形式で指定する。1 日に複数の時間帯を書けるため、昼休みなどを除外できる。書かなかった曜日や空配列の曜日は作業なしとして扱う。
- 期日提案は作業時間内の空き時間だけを数え、作業時間外（自由時間・睡眠時間）にはタスクを割り当てない。作業時間のない曜日は期日の候補にしない。
- 未知の曜日キー、書式の誤った時刻、重なった時間帯、全曜日が空の設定はエラーになる。

## ロードマップ

- [ ] Task / Calendar の共通インターフェース設計
- [x] gws連携層の実装
- [ ] Gemini を用いたLLM抽象化層の実装
- [x] Google Calendar / Google Tasks との連携確認（複数アカウント対応）
- [ ] タスク×スケジュールを踏まえた提案ロジックの実装
- [ ] CLI としてのUX整備
- [ ] 他LLM Provider・他サービスへの対応拡大

## ライセンス

[MIT License](./LICENSE)
