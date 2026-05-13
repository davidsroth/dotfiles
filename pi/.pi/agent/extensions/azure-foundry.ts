import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.AZURE_INFERENCE_ENDPOINT?.trim() || process.env.AZURE_FOUNDRY_ENDPOINT?.trim() || "";

  if (!baseUrl) {
    console.warn("[azure-foundry] No endpoint configured. Set AZURE_INFERENCE_ENDPOINT or AZURE_FOUNDRY_ENDPOINT to enable.");
    return;
  }

  pi.registerProvider("azure-foundry", {
    baseUrl,
    apiKey: "AZURE_INFERENCE_CREDENTIAL",
    authHeader: true,
    api: "openai-completions",
    models: [
      {
        // Must match your exact deployment name in Azure AI Foundry
        id: "Kimi-K2.6", // deployment name
        name: "Kimi K2.6 (Azure Foundry)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 262142,
        maxTokens: 131072,
        cost: {
          input: 0.74,
          output: 3.49,
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
