import { describe, expect, it } from "vitest";
import {
  bindLogAttributes,
  extendLogAttributes,
  getBoundLogAttributes,
} from "@/chat/log-context";

describe("log context", () => {
  it("inherits and restores nested async context", async () => {
    expect(getBoundLogAttributes()).toEqual({});

    await bindLogAttributes({ "app.request.id": "outer" }, async () => {
      expect(getBoundLogAttributes()).toEqual({ "app.request.id": "outer" });

      await bindLogAttributes({ "app.run.id": "inner" }, async () => {
        await Promise.resolve();
        expect(getBoundLogAttributes()).toEqual({
          "app.request.id": "outer",
          "app.run.id": "inner",
        });
      });

      expect(getBoundLogAttributes()).toEqual({ "app.request.id": "outer" });
    });

    expect(getBoundLogAttributes()).toEqual({});
  });

  it("extends only the current async context", async () => {
    await bindLogAttributes({ "app.request.id": "request" }, async () => {
      extendLogAttributes({ "app.run.id": "run" });
      expect(getBoundLogAttributes()).toEqual({
        "app.request.id": "request",
        "app.run.id": "run",
      });
    });

    expect(getBoundLogAttributes()).toEqual({});
  });
});
