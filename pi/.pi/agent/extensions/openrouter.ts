import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.warn("[openrouter] No API key configured. Set OPENROUTER_API_KEY to enable.");
    return;
  }

  pi.registerProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "OPENROUTER_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6 (OpenRouter)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 262142,
        maxTokens: 131072,
        cost: {
          input: 0.60,
          output: 2.80,
          cacheRead: 0,
          cacheWrite: 0,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
}
