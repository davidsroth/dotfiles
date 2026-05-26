// pi-intercom-tailnet extension entry.
//
// Phase 0 surface: just auto-spawn the relay if it's enabled in config.
// No new tools — DMs work through the existing `intercom` tool because
// remote sessions show up as `<name>@<host>` virtual sessions on the
// local broker.
//
// Phase 1 will add: list_grants / revoke_grant, channel verbs
// (post/read/tail), and an interactive approval flow.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadTailnetConfig } from "./config.ts";
import { spawnRelayIfNeeded, isRelayRunning } from "./relay/spawn.ts";

export default function piIntercomTailnetExtension(_pi: ExtensionAPI) {
  const config = loadTailnetConfig();
  if (!config.enabled) return;

  if (config.allowedHosts.length === 0) {
    console.error(
      "[pi-intercom-tailnet] enabled but allowedHosts is empty; refusing to spawn relay",
    );
    return;
  }

  try {
    spawnRelayIfNeeded();
    if (!isRelayRunning()) {
      // The relay may still be starting up; this isn't a hard error.
      console.error("[pi-intercom-tailnet] relay spawn requested; pid file not yet present");
    }
  } catch (err) {
    console.error("[pi-intercom-tailnet] failed to spawn relay:", err);
  }
}
