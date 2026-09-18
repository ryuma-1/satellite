import { GoogleGenAI } from "@google/genai";
import type { LLMProvider } from "./types";

export class GeminiProvider implements LLMProvider {
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = "gemini-3.5-flash-lite") {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
    });
    return response.text ?? "";
  }
}
