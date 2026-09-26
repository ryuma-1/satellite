---
applyTo: '"**/*.cs"'
---
# Project Instructions
他で定義されているルールに加えて、以下のガイドラインに従ってください

## 1. Project Context
- **Language**: C# (Latest version)
- **Framework**: Unity / .NET Core
- **Architectural Style**: Domain-Driven Design (DDD), Immutable Architecture
- **Key Libraries**: UniRx, Zenject (必要に応じて記述)

## 2. Coding Standards

### General Rules
- **Immutability**: 原則として不変（Immutable）な設計を優先する。状態変更が必要な場合は、新しいインスタンスを生成して返す。
- **LINQ**: 可読性を損なわない範囲で積極的に使用する。
- **Early Return**: ネストを深くしないため、ガード節と早期リターンを使用する。

### Naming Conventions
- **Classes/Methods/Properties**: `PascalCase`
- **Arguments/Local Variables**: `camelCase`
- **Private Fields**: `_camelCase` (アンダースコア必須)
- **Constants/Static Readonly**: `UPPER_SNAKE_CASE`

### Member Ordering (Strict)
コードの可読性を統一するため、クラス内のメンバーは以下の順序で配置すること。

1.  **Constants / Static Fields** (最上部)
2.  **Fields** (`private readonly` 等)
3.  **Properties**
4.  **Constructors**
5.  **Public Methods** (主要ロジック)
6.  **Private Methods** (ヘルパー、詳細ロジック)

※ 各セクションの区切りには `// === Section Name === //` 形式のコメントを入れること。

## 3. Documentation Guidelines (XML Comments)

### Format
- すべての `public` クラス・メソッド・プロパティにXMLドキュメント (`///`) を記述する。
- タグ要件:
    - `<summary>`: 概要（必須）
    - `<param>`: 引数の説明（null許容性を含む）
    - `<returns>`: 戻り値の説明
    - `<exception>`: 送出される可能性のある例外条件（必須）
    - `<remarks>`: 設計意図、不変性、注意点（推奨）

### Content
- **Why over What**: 「何をしているか」はコードで語り、ドキュメントには「なぜそうしているか（意図・設計判断）」を記述する。

## 4. Testing Guidelines

### Framework
- **Tools**: NUnit / Moq

### Test Structure & Naming
- テストメソッドの命名規則: `Test_MethodName_Scenario`
    - 例: `Test_Constructor_Success`, `Test_Calculate_ThrowException_WhenValueIsNull`
- **One Assert per Test**: 原則として1つのテストメソッドで検証するアサーションは1つの概念に絞る。

### Boundary Value Analysis
境界値（例: MAX=255）に関わるテストを作成する場合は、以下の3点を必ず網羅する。
1.  **Safe**: 境界値 - 1 (成功)
2.  **Edge**: 境界値 (成功)
3.  **Out**: 境界値 + 1 (失敗/例外)

## 5. Refactoring Instructions
AIがコードを修正・リファクタリングする際は、以下のステップを踏むこと。
1.  既存のロジック（挙動）を変えないことを確認する。
2.  上記の「Member Ordering」に従って並び替えを行う。
3.  不足しているXMLドキュメントを追記する。