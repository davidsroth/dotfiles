import { describe, expect, it } from "vitest";
import { waitForCompletionOrAbort } from "../src/index.js";

describe("waitForCompletionOrAbort", () => {
  it("returns promptly and restores caller state when the tool signal is aborted", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controller = new AbortController();
    let restored = false;

    const waiting = waitForCompletionOrAbort(pending, controller.signal, () => {
      restored = true;
    });

    controller.abort();

    expect(restored).toBe(true);
    await expect(waiting).resolves.toBe(false);
    complete();
  });

  it("waits for normal completion without invoking the abort callback", async () => {
    const controller = new AbortController();
    let aborted = false;

    await expect(
      waitForCompletionOrAbort(Promise.resolve(), controller.signal, () => {
        aborted = true;
      }),
    ).resolves.toBe(true);

    expect(aborted).toBe(false);
  });
});
