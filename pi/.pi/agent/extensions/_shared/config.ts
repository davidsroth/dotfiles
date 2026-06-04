/**
 * _shared/config.ts — layered JSON config loading for extensions.
 *
 * This directory has no `index.ts` / `package.json` pi-manifest, so pi's
 * extension discovery does NOT auto-load it (it only loads top-level `*.ts`
 * and subdirs with an index/manifest). It is a plain helper module that other
 * extensions import via a relative path.
 *
 * The layered pattern (read a global default from ~/.pi/agent/<file> and let a
 * per-project <cwd>/.pi/<file> override it, ignoring malformed JSON with a
 * warning) was duplicated across advisor.ts and secret-guard.ts. This is the
 * single source of truth.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Read and JSON-parse a config file. Returns `undefined` if the file is absent
 * or malformed (a warning is logged for malformed files). Never throws.
 */
export function readJsonConfig(path: string, logPrefix: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[${logPrefix}] Ignoring malformed config at ${path}: ${reason}`);
    return undefined;
  }
}

export interface LoadLayeredConfigOptions<T> {
  /** Bare filename, e.g. "advisor.json". */
  filename: string;
  /** Current working directory (for the project-level override). */
  cwd: string;
  /** Prefix for warning messages, e.g. "advisor". */
  logPrefix: string;
  /** Base defaults, merged with lowest precedence. */
  defaults?: Partial<T>;
  /**
   * Per-file normalizer applied to each layer's raw parsed value before
   * merging. Defaults to passing objects through and dropping non-objects.
   */
  sanitize?: (raw: unknown) => Partial<T>;
}

function defaultSanitize<T>(raw: unknown): Partial<T> {
  return raw && typeof raw === "object" ? (raw as Partial<T>) : {};
}

/**
 * Load a config layered as: defaults < ~/.pi/agent/<filename> < <cwd>/.pi/<filename>.
 * Each layer is parsed defensively and normalized via `sanitize`.
 */
export function loadLayeredConfig<T>(opts: LoadLayeredConfigOptions<T>): T {
  const { filename, cwd, logPrefix, defaults = {}, sanitize = defaultSanitize<T> } = opts;
  const global = sanitize(readJsonConfig(join(getAgentDir(), filename), logPrefix));
  const project = sanitize(readJsonConfig(join(cwd, ".pi", filename), logPrefix));
  return { ...defaults, ...global, ...project } as T;
}
