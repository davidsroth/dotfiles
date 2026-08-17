/**
 * Public activity snapshot contract for extensions that need to observe active
 * pi-subagents without reaching into AgentManager internals.
 *
 * Pi runs root and child extension instances in one process. Activity therefore
 * lives in a registry keyed by the owning Pi session ID: a child session must
 * never replace or remove its root session's snapshot.
 */

export type ActiveSubagentStatus = "queued" | "running";

export interface ActiveSubagentSnapshot {
  id: string;
  type: string;
  description: string;
  status: ActiveSubagentStatus;
}

export interface SubagentActivityProvider {
  /** Returns the current queued and running subagents for one Pi session. */
  getActiveSubagents(): ActiveSubagentSnapshot[];
}

export interface SubagentActivityRegistry {
  /** Returns the current queued and running subagents for the requested Pi session. */
  getActiveSubagents(sessionId: string): ActiveSubagentSnapshot[];
}

/**
 * Shared registry key for session-keyed activity. It uses Symbol.for() so
 * independently loaded Pi extensions (including Herdr's managed integration)
 * can read the documented contract without importing this package.
 */
export const SUBAGENT_ACTIVITY_REGISTRY_KEY = Symbol.for("pi-subagents:activity-registry");

/** @deprecated Use SUBAGENT_ACTIVITY_REGISTRY_KEY and a session ID instead. */
export const SUBAGENT_ACTIVITY_PROVIDER_KEY = Symbol.for("pi-subagents:activity");

type RegistryStore = {
  providers: Map<string, SubagentActivityProvider>;
  registry: SubagentActivityRegistry;
};

function registryStore(): RegistryStore {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const current = globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
  if (
    current
    && typeof current === "object"
    && (current as Partial<RegistryStore>).providers instanceof Map
    && typeof (current as Partial<RegistryStore>).registry?.getActiveSubagents === "function"
  ) {
    return current as RegistryStore;
  }

  const providers = new Map<string, SubagentActivityProvider>();
  const store: RegistryStore = {
    providers,
    registry: {
      getActiveSubagents(sessionId: string): ActiveSubagentSnapshot[] {
        const provider = providers.get(sessionId);
        return provider ? provider.getActiveSubagents() : [];
      },
    },
  };
  globals[SUBAGENT_ACTIVITY_REGISTRY_KEY] = store;
  return store;
}

/** Register one session's snapshot provider and return its ownership-safe cleanup. */
export function registerSubagentActivityProvider(
  sessionId: string,
  provider: SubagentActivityProvider,
): () => void {
  const store = registryStore();
  store.providers.set(sessionId, provider);
  return () => {
    // A reload may have already registered a new provider for this same ID.
    if (store.providers.get(sessionId) === provider) {
      store.providers.delete(sessionId);
    }
  };
}

/** Return the process-global read-only registry for integrations. */
export function getSubagentActivityRegistry(): SubagentActivityRegistry {
  return registryStore().registry;
}

/** Get a read-only activity provider for a particular Pi session. */
export function getSubagentActivityProvider(sessionId: string): SubagentActivityProvider | undefined {
  const store = registryStore();
  if (!store.providers.has(sessionId)) return undefined;
  return {
    getActiveSubagents: () => store.registry.getActiveSubagents(sessionId),
  };
}
