import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * Model used when SATELLITE_MODEL is not set.
 */
export const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

/**
 * Creates the Gemini model used by the planning layer (design_doc §5.1).
 * The key is read from GEMINI_API_KEY rather than the SDK's default GOOGLE_GENERATIVE_AI_API_KEY,
 * so existing .env files keep working.
 */
export function createModel(env: Record<string, string | undefined> = process.env): LanguageModel {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません（.env を確認してください）");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google(env.SATELLITE_MODEL || DEFAULT_MODEL_ID);
}
