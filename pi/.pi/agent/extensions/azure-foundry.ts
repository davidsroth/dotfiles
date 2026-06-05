import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.AZURE_INFERENCE_ENDPOINT?.trim() || process.env.AZURE_FOUNDRY_ENDPOINT?.trim() || "";

  if (!baseUrl) {
    return;
  }

  pi.registerProvider("azure-foundry", {
    baseUrl,
    apiKey: "$AZURE_INFERENCE_CREDENTIAL",
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
      {
        // Requires a Foundry deployment named "FW-GLM-5.1" (Fireworks GLM 5.1,
        // version 1, DataZoneStandard SKU). Until that deployment exists this
        // model entry will 404 (DeploymentNotFound) when invoked.
        id: "FW-GLM-5.1", // deployment name
        name: "GLM 5.1 (Azure Foundry)",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 131072,
        cost: {
          // DataZoneStandard pay-per-token, USD per 1M tokens
          input: 1.54,
          output: 4.84,
          cacheRead: 0.286,
          cacheWrite: 0,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        // Requires a Foundry deployment named "DeepSeek-V4-Pro" (DeepSeek
        // first-party, version 2026-04-23, GlobalStandard SKU). Until that
        // deployment exists this entry will 404 (DeploymentNotFound).
        id: "DeepSeek-V4-Pro", // deployment name
        name: "DeepSeek V4 Pro (Azure Foundry)",
        reasoning: false,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 131072,
        cost: {
          // GlobalStandard pay-per-token, USD per 1M tokens
          input: 1.74,
          output: 3.48,
          cacheRead: 0.165,
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
