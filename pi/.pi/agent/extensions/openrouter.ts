import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Configure the API key for pi's built-in OpenRouter provider.
// Use "$VAR" syntax so pi resolves it at runtime from the environment.
// No models needed here — pi ships with the full OpenRouter model catalog.
export default function (pi: ExtensionAPI) {
  pi.registerProvider("openrouter", {
    apiKey: "$OPENROUTER_API_KEY",
  });
}
