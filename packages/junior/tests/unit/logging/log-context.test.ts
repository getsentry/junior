import { describe, expect, it } from "vitest";
import {
  getBoundLogAttributes,
  runWithLogContext,
} from "@/chat/log-context";

describe("log context", () => {
  it("maps typed context and restores nested async scopes", async () => {
    expect(getBoundLogAttributes()).toEqual({});

    await runWithLogContext(
      { requestId: "outer", destinationName: "channel" },
      async () => {
        expect(getBoundLogAttributes()).toEqual({
          "app.request.id": "outer",
          "messaging.destination.name": "channel",
        });

        await runWithLogContext({ runId: "inner" }, async () => {
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

  it("isolates concurrent operations", async () => {
    const seen = await Promise.all(
      ["first", "second"].map((runId) =>
        runWithLogContext({ runId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return getBoundLogAttributes()["app.run.id"];
        }),
      ),
    );

    expect(seen).toEqual(["first", "second"]);
    expect(getBoundLogAttributes()).toEqual({});
  });
});
