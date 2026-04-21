import { describe, expect, it } from "vitest";
import { buildToolProgressStatus } from "@/chat/runtime/tool-progress";

describe("buildToolProgressStatus", () => {
  it("uses the fetched URL domain when building web progress", () => {
    expect(
      buildToolProgressStatus("webFetch", {
        url: "https://docs.slack.dev/ai/developing-agents/",
      }),
    ).toEqual({
      text: "Reading docs.slack.dev",
    });
  });

  it("falls back to a concrete generic phase when tool arguments are missing", () => {
    expect(buildToolProgressStatus("webSearch", {})).toEqual({
      text: "Searching sources",
    });
    expect(buildToolProgressStatus("bash", {})).toEqual({
      text: "Running checks",
    });
  });
});
