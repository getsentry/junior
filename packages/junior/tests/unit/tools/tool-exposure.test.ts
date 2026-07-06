import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import { tool } from "@/chat/tools/definition";

describe("planToolExposure", () => {
  it("separates native-visible, catalog-executable, and excluded tools", () => {
    const directDefault = tool({
      description: "Direct by default",
      inputSchema: Type.Object({}),
    });
    const directExplicit = tool({
      description: "Direct explicitly",
      exposure: "direct",
      inputSchema: Type.Object({}),
    });
    const deferred = tool({
      description: "Deferred",
      exposure: "deferred",
      inputSchema: Type.Object({}),
    });
    const modelOnly = tool({
      description: "Reserved model-only exposure",
      exposure: "modelOnly",
      inputSchema: Type.Object({}),
    });
    const hidden = tool({
      description: "Hidden",
      exposure: "hidden",
      inputSchema: Type.Object({}),
    });

    expect(
      planToolExposure({
        deferred,
        directDefault,
        directExplicit,
        hidden,
        modelOnly,
      }),
    ).toEqual({
      catalogTools: {
        deferred,
        directDefault,
        directExplicit,
      },
      directTools: {
        directDefault,
        directExplicit,
      },
      excludedTools: {
        hidden,
        modelOnly,
      },
    });
  });
});
