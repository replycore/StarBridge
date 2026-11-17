import { __name } from "../helpers.js";
import { anthropicAdapter } from "./anthropic.js";
import { geminiAdapter } from "./gemini.js";
import { openaiAdapter } from "./openai.js";

export function adapterFor(kind) {
  switch (kind) {
    case "anthropic":
      return anthropicAdapter;
    case "gemini":
      return geminiAdapter;
    case "openai":
      return openaiAdapter;
    default:
      throw new Error(`unknown provider kind: ${String(kind)}`);
  }
}
__name(adapterFor, "adapterFor");
