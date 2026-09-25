---
name: add-comment
description: 現在のファイルのコードにコメントを追加
argument-hint: "コメントを追加したいファイルを選択してください．(引数をしていない場合は，現在開いているファイルにコメントを追加します)"
agent: agent
model: Claude Haiku 4.5 (copilot)
tools: [read/readFile, edit]
---

# コメント追加プロンプト

対象ファイル: `${file}`
コンテキスト: `${workspaceFolderBasename}`
選択範囲: `${selection}`

## 実行要件
あなたは熟練したC#アーキテクトです。対象のコードに対し、**保守性と可読性を最大化するXMLドキュメンテーションコメント**を追記してください。

### 1. インターフェースと実装の書き分けルール（最重要）
- **インターフェース (interface)**:
  - 「契約」として、そのメソッドが「何をするか（What）」を最大限詳細に記述します。
  - `<summary>`, `<param>`, `<returns>`, `<exception>` を完全に網羅してください。
- **実装クラス (class)**:
  - インターフェースを実装しているメソッドには、原則として **`<inheritdoc />`** のみを使用し、コメントの重複管理を避けてください。
  - ただし、その実装固有の特殊な振る舞い（キャッシュの利用、特定のアルゴリズムの採用など）がある場合に限り、`<summary>` や `<remarks>` を上書き、または追記してください。

### 2. ドキュメント記述ルール (XML Comments)
- **必須タグ**:
  - `<summary>`: メソッドやクラスの簡潔な説明。
  - `<param>`: 引数の説明（null許容性や制約を含む）。
  - `<returns>`: 戻り値の説明（特定の条件での変化を含む）。
  - `<exception>`: 送出される可能性のある例外とその条件を網羅する（`ArgumentNullException` 等）。
- **推奨タグ**:
  - `<remarks>`: 実装の詳細、設計上の決定事項（例: 不変性、スレッドセーフ性）、使用上の注意点を記述。
  - `<see cref="T"/>`: 関連するクラスやメソッドへの参照リンクを積極的に使用。
- **言語**: 日本語

### 3. インラインコメント記述ルール
- ロジックが複雑な箇所（インデックス計算、ビット演算、条件分岐）には、コードの内部に `//` でコメントを追加する。
- 「何をしているか（What）」ではなく**「なぜそうしているか（Why/Intent）」**を記述する。
- 基本は記述不要であるが、特に注意が必要な部分にはコメントを追加する。

### 4. 既存コメントに対するルール
- 既存コメントが不正確または不十分な場合は、適切に修正または拡充してください。
- 既存のコメントが十分で正確であれば、そのまま維持してください。
- 既存のインターフェース実装に対し、冗長な説明が書かれている場合は `<inheritdoc />` への置換を検討してください。

### 5. 注意事項
- 既存のロジックやコード構造は変更しないでください。
- コメントは過剰にならないように注意し、必要最低限で明確に伝わるようにしてください。


### サンプル

#### Before
public IMenu SelectUp()
{
    if (_index == 0) return SelectBottom();
    return new Menu(_items, _index - 1);
}

#### After
/// <summary>
/// 選択カーソルを1つ上に移動します。
/// </summary>
/// <remarks>
/// 現在のカーソルが最上部（インデックス0）の場合は、最下部の項目へ循環（ループ）します。
/// <para>このクラスは不変であるため、状態変更後は新しい <see cref="IMenu"/> インスタンスを返します。</para>
/// </remarks>
/// <returns>カーソル位置が更新された新しいメニューインスタンス。</returns>
public IMenu SelectUp()
{
    if (_index == 0) return SelectBottom();
    return new Menu(_items, _index - 1);
}

#### Interface
/// <summary>
/// メニューの操作を定義します。
/// </summary>
public interface IMenu
{
    /// <summary>
    /// 選択カーソルを1つ上に移動します。
    /// </summary>
    /// <returns>新しい状態を持つメニューインスタンス。</returns>
    IMenu SelectUp();
}

#### Implementation
public class Menu : IMenu
{
    /// <inheritdoc />
    /// <remarks>
    /// インデックスが 0 の場合は末尾へループする実装となっています。
    /// </remarks>
    public IMenu SelectUp()
    {
        if (_index == 0) return SelectBottom();
        return new Menu(_items, _index - 1);
    }
}
