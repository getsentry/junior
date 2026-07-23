import { describe, expect, it } from "vitest";
import {
  getBoundLogAttributes,
  getBoundLogContext,
  runWithLogAttributes,
  runWithLogContext,
  updateLogAttributes,
} from "@/chat/log-context";

describe("log context", () => {
  it("restores nested async scopes", async () => {
    expect(getBoundLogAttributes()).toEqual({});

    await runWithLogAttributes(
      {
        "app.request.id": "outer",
        "messaging.destination.name": "channel",
      },
      async () => {
        expect(getBoundLogAttributes()).toEqual({
          "app.request.id": "outer",
          "messaging.destination.name": "channel",
        });

        await runWithLogAttributes({ "app.run.id": "inner" }, async () => {
          await Promise.resolve();
          expect(getBoundLogAttributes()).toEqual({
            "app.request.id": "outer",
            "app.run.id": "inner",
            "messaging.destination.name": "channel",
          });
        });

        expect(getBoundLogAttributes()).toEqual({
          "app.request.id": "outer",
          "messaging.destination.name": "channel",
        });
      },
    );

    expect(getBoundLogAttributes()).toEqual({});
  });

  it("inherits defined typed context through nested scopes", async () => {
    await runWithLogContext(
      { conversationId: "conversation", modelId: "outer-model" },
      {},
      async () => {
        await runWithLogContext(
          { modelId: undefined, runId: "inner-run" },
          {},
          async () => {
            expect(getBoundLogContext()).toEqual({
              conversationId: "conversation",
              modelId: "outer-model",
              runId: "inner-run",
            });
          },
        );
      },
    );

    expect(getBoundLogContext()).toEqual({});
  });

  it("isolates concurrent operations", async () => {
    const seen = await Promise.all(
      ["first", "second"].map((runId) =>
        runWithLogAttributes({ "app.run.id": runId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return getBoundLogAttributes()["app.run.id"];
        }),
      ),
    );

    expect(seen).toEqual(["first", "second"]);
    expect(getBoundLogAttributes()).toEqual({});
  });

  it("updates only an existing scoped operation", async () => {
    updateLogAttributes({ "app.run.id": "ignored" });
    expect(getBoundLogAttributes()).toEqual({});

    await runWithLogAttributes({ "app.request.id": "request" }, async () => {
      updateLogAttributes({ "app.run.id": "run" });
      expect(getBoundLogAttributes()).toEqual({
        "app.request.id": "request",
        "app.run.id": "run",
      });
    });

    expect(getBoundLogAttributes()).toEqual({});
  });
});
