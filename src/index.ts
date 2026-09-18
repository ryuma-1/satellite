import { GeminiProvider } from "./llm/gemini_provider";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません（.env を確認してください）");
  }

  const question = process.argv.slice(2).join(" ");
  if (!question) {
    throw new Error("質問文を引数として指定してください（例: bun run src/index.ts 質問内容）");
  }

  const llm = new GeminiProvider(apiKey);

  const result = await llm.generate(question);
  console.log(result);
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
