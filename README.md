# satellite

MCP (Model Context Protocol) を介して外部サービス（タスク管理・カレンダーなど）と連携し、ユーザーの状況を踏まえた提案を行う AI Assistant CLI ツールです。

> **Status**: 構想・設計段階。本READMEは実装前の企画書的な位置づけです。

## 目次

- [概要](#概要)
- [背景・モチベーション](#背景モチベーション)
- [コンセプト](#コンセプト)
- [アーキテクチャ](#アーキテクチャ)
- [技術スタック](#技術スタック)
- [セットアップ（予定）](#セットアップ予定)
- [設定](#設定)
- [ロードマップ](#ロードマップ)
- [ライセンス](#ライセンス)

## 概要

satellite は、LLM を中核に据えつつ、タスク管理サービスやカレンダーサービスといった外部ツールを **MCP 経由で** 利用する AI Assistant です。単なる「AIからカレンダーを操作できるツール」ではなく、複数のサービスから取得した情報を組み合わせて状況を理解し、次に取るべき行動を提案することを目指します。

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
LLM + Tool利用(MCP) + 状況理解 + Planning
```

- **特定サービスに依存しない**: タスク管理・カレンダーそれぞれについて、具体的なサービス（Google Tasks / Todoist / Google Calendar など）を共通インターフェースの背後に隠蔽する。
- **特定LLMに依存しない**: LLM 呼び出し部分も抽象化レイヤーを設け、Provider を差し替え可能にする。
- **既存資産の活用**: MCPサーバーは可能な限り既存の公開実装（Google Calendar MCP など）を再利用し、自作は最小限に留める。

## アーキテクチャ

```
                    AI Assistant (CLI)
                         │
                       LLM
                    (Provider抽象化)
                         │
                  MCP Client Layer
                         │
        ┌────────────────┴────────────────┐
        ▼                                  ▼
   Task Interface                   Calendar Interface
   (サービス抽象化)                   (サービス抽象化)
        │                                  │
   ┌────┼────┐                        ┌────┴────┐
   ▼    ▼    ▼                        ▼         ▼
Todoist GTasks Notion              Google    Outlook
  MCP    MCP    MCP                Calendar    Calendar
                                     MCP         MCP
```

- **AI Assistant (CLI)**: ターミナルから対話する形式のエントリポイント。
- **LLM layer**: 特定モデルに依存しない抽象化レイヤー。初期実装は Gemini を対象とする。
- **MCP Client Layer**: 各種 MCP サーバーと通信し、Tool として LLM に提供する層。
- **Task / Calendar Interface**: 個別サービスの違いを吸収する抽象化層。MVP では Task・Calendar の両方を対象とする。

## 技術スタック

| 項目 | 選定 |
|---|---|
| 言語 | TypeScript |
| ランタイム / パッケージ管理 | Bun |
| 外部連携 | MCP (Model Context Protocol) |
| LLM (初期対応) | Gemini |
| 実行形態 | CLI |
| 想定利用者 | 個人利用 |

## セットアップ（予定）

> 実装前のため、以下は想定であり今後変更の可能性があります。

```bash
git clone https://github.com/<your-account>/satellite.git
cd satellite
bun install
cp .env.example .env
# .env にAPIキー・MCPサーバー接続情報を設定
bun run start
```

## 設定

APIキーおよび MCP サーバーの接続情報は環境変数 (`.env`) で管理します。

```env
# LLM
GEMINI_API_KEY=

# MCP servers
GOOGLE_CALENDAR_MCP_ENDPOINT=
# 他サービスのMCPサーバー接続情報を追加
```

## ロードマップ

- [ ] Task / Calendar の共通インターフェース設計
- [ ] MCP Client Layer の実装
- [ ] Gemini を用いたLLM抽象化層の実装
- [ ] Google Calendar MCP との連携確認
- [ ] タスク×スケジュールを踏まえた提案ロジックの実装
- [ ] CLI としてのUX整備
- [ ] 他LLM Provider・他サービスへの対応拡大

## ライセンス

[MIT License](./LICENSE)
