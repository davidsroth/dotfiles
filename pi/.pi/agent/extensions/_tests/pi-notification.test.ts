import { describe, expect, it } from "vitest";
import {
  buildNotificationCopy,
  isBackgroundAgentNudgeRun,
  isInteractiveSession,
  shouldSendDesktopNotification,
} from "../pi-notification";

const values = {
  project: "secret-project",
  branch: "customer-name",
  location: "private-session:1.0",
  duration: "12s",
  assistantText: "Sensitive response details",
};

describe("pi notification background agents", () => {
  it("notifies only from the interactive TUI", () => {
    expect(isInteractiveSession({ mode: "tui", hasUI: true })).toBe(true);
    expect(isInteractiveSession({ mode: "print", hasUI: false })).toBe(false); // in-process subagent
    expect(isInteractiveSession({ mode: "rpc", hasUI: true })).toBe(false); // agent-host plate/librarian
    expect(isInteractiveSession({ mode: "json", hasUI: false })).toBe(false);
    // Older runtimes without ctx.mode fall back to hasUI.
    expect(isInteractiveSession({ hasUI: false })).toBe(false);
    expect(isInteractiveSession({ hasUI: true })).toBe(true);
    expect(isInteractiveSession(undefined)).toBe(true);
  });

  const nudge = { role: "custom", customType: "subagent-notification", content: "done" };
  const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  const toolResult = { role: "toolResult", content: [] };
  const user = { role: "user", content: "hi" };

  it("detects parent runs started only by completion follow-ups", () => {
    expect(isBackgroundAgentNudgeRun([nudge, assistant])).toBe(true);
    expect(isBackgroundAgentNudgeRun([nudge, nudge, assistant, toolResult, assistant])).toBe(true);
  });

  it("still notifies for user prompts and other triggers", () => {
    expect(isBackgroundAgentNudgeRun([user, assistant])).toBe(false);
    expect(isBackgroundAgentNudgeRun([user, assistant, nudge, assistant])).toBe(false);
    expect(isBackgroundAgentNudgeRun([{ role: "custom", customType: "intercom_message" }, assistant])).toBe(false);
    expect(isBackgroundAgentNudgeRun([assistant])).toBe(false);
    expect(isBackgroundAgentNudgeRun(undefined)).toBe(false);
  });
});

describe("pi notification privacy", () => {
  it("defers completion notifications to Herdr inside a Herdr pane", () => {
    expect(shouldSendDesktopNotification({ HERDR_ENV: "1" })).toBe(false);
    expect(shouldSendDesktopNotification({ HERDR_ENV: "" })).toBe(true);
    expect(shouldSendDesktopNotification({})).toBe(true);
  });

  it("hides response and project context by default", () => {
    expect(buildNotificationCopy(values, {})).toEqual({
      title: "Pi",
      subtitle: "12s",
      message: "Ready for input",
    });
  });

  it("allows context and previews only through explicit opt-ins", () => {
    const copy = buildNotificationCopy(values, {
      PI_NOTIFICATION_INCLUDE_CONTEXT: "1",
      PI_NOTIFICATION_INCLUDE_PREVIEW: "true",
    });
    expect(copy.title).toBe("Pi · secret-project");
    expect(copy.subtitle).toContain("customer-name");
    expect(copy.subtitle).toContain("private-session:1.0");
    expect(copy.message).toBe("Sensitive response details");
  });
});
