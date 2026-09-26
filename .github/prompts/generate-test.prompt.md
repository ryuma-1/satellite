---
name: generate-test
description: 現在のファイルのテストコードを生成
argument-hint: "テスト対象のファイルを指定してください"
agent: agent
model: Claude Sonnet 4.5 (copilot)
tools: [read/readFile, edit, edit/createFile]
---

# 単体テスト生成タスク

対象ファイル: `${file}`
コンテキスト: `${workspaceFolderBasename}`
フレームワーク: `${NUnit}`

## 実行要件
あなたは品質保証（QA）スペシャリストです。対象コードの「コンストラクタ」および「パブリックメソッド」に対して、以下の厳格なルールに基づき網羅的なテストコードを作成してください。

### 1. テスト作成の基本方針
- **対象**: クラス内のすべての `public` メソッドおよびコンストラクタ。
- **ケース分類**: 1つのメソッドにつき、以下の観点で複数のテストメソッドを作成すること。
  1.  **正常系 (Success)**: 期待通りに動作するケース。
  2.  **異常系 (Error)**: 引数が `null` や不正な値の場合に例外がスローされるケース。
  3.  **境界値 (Boundary)**: 数値やリスト数に制限がある場合、その限界値を検証するケース。

### 2. 境界値テストのルール
境界値（例: `MAX = 255`）が存在する場合、必ず以下の3点をテストすること。
- **境界値 - 1** (Safe: 成功すべき)
- **境界値** (Edge: 成功すべき)
- **境界値 + 1** (Out: 失敗/例外になるべき)

### 3. 命名規則
以下のフォーマットを厳守すること。
-　**クラス名** `Test[対象クラス名]`
-　**関数名** `Test_[メソッド名]_[テスト内容・条件]()`

例:
- `TestExampleClass`
- `Test_Constructor_Success()`
- `Test_Constructor_ThrowException_WhenContentsIsNull()`
- `Test_SelectUp_Boundary_MinMinusOne()`

### 4. モックの利用
- `ISelectableContent` などのインターフェース依存がある場合は、`Moq` または単純なスタブクラスを使用して依存関係を解決した状態でテストを作成すること。

### 5. 既存のテストコードがある場合
- 既存のテストコードがある場合は、既存のテストコードが要件を満たしているか確認し、不足分のみを追加してください。
- 既存のテストコードが要件を満たしている場合は、新たなテストコードを生成しないでください。

### 6. Assert文
- Assert文を使用して、期待される結果を明確に検証してください。
- Assert文ではエラーメッセージを英語で明示的に指定してください。

### 7. ドキュメントコメント
- 各テストメソッドの目的と検証内容を簡潔に説明してください。
- 基本は Arrange-Act-Assert パターンに従って記述してください。


## 出力形式
- テストクラスのコードブロックのみを出力してください。
- 必要な `using` ディレクティブを含めてください。

### サンプル

#### 対象コード
public void SetVolume(int vol) {
    if (vol < 0 || vol > 100) throw new ArgumentOutOfRangeException();
    _volume = vol;
}

#### 生成されるテストコード
```csharp
[Test]
public void Test_SetVolume_Success()
{
    // Arrange
    var obj = new AudioPlayer();

    // Act
    obj.SetVolume(50);

    // Assert
    Assert.AreEqual(50, obj.Volume);
}

[Test]
public void Test_SetVolume_Boundary_Min()
{
    // Arrange
    var obj = new AudioPlayer();

    // Act
    obj.SetVolume(0); // 境界値

    // Assert
    Assert.AreEqual(0, obj.Volume);
}

[Test]
public void Test_SetVolume_Boundary_MinMinusOne()
{
    // Arrange
    var obj = new AudioPlayer();

    // Act & Assert
    // 境界値 - 1 (エラー)
    Assert.Throws<ArgumentOutOfRangeException>(() => obj.SetVolume(-1));
}

[Test]
public void Test_SetVolume_Boundary_Max()
{
    // Arrange
    var obj = new AudioPlayer();

    // Act
    obj.SetVolume(100); // 境界値

    // Assert
    Assert.AreEqual(100, obj.Volume);
}

[Test]
public void Test_SetVolume_Boundary_MaxPlusOne()
{
    // Arrange
    var obj = new AudioPlayer();

    // Act & Assert
    // 境界値 + 1 (エラー)
    Assert.Throws<ArgumentOutOfRangeException>(() => obj.SetVolume(101));
}