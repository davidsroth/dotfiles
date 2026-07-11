import test from "node:test";
import assert from "node:assert/strict";
import { buildRelayEnv } from "../relay/spawn.js";

test("buildRelayEnv keeps runtime settings and excludes credentials", () => {
  const env = buildRelayEnv({
    PATH: "/bin",
    HOME: "/home/test",
    PI_INTERCOM_TAILNET_MAX_FRAME_BYTES: "1024",
    OPENROUTER_API_KEY: "secret",
    SLACK_MCP_XOXP_TOKEN: "secret",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.PI_INTERCOM_TAILNET_MAX_FRAME_BYTES, "1024");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.SLACK_MCP_XOXP_TOKEN, undefined);
});
