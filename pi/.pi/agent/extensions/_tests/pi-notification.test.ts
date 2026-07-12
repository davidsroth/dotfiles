import { describe, expect, it } from "vitest";
import { buildNotificationCopy } from "../pi-notification";

const values = {
  project: "secret-project",
  branch: "customer-name",
  location: "private-session:1.0",
  duration: "12s",
  assistantText: "Sensitive response details",
};

describe("pi notification privacy", () => {
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
