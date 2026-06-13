import { describe, expect, it } from "vitest";
import {
  buildUserTurnInput,
  buildUserTurnText,
} from "@/chat/respond/user-turn-input";

describe("buildUserTurnText", () => {
  it("returns raw input when no context or metadata is provided", () => {
    expect(buildUserTurnText("hello")).toBe("hello");
  });

  it("keeps only causal thread context around the current instruction", () => {
    expect(buildUserTurnText("what now?", "alice: budget is due Friday")).toBe(
      [
        "<thread-background>",
        "alice: budget is due Friday",
        "</thread-background>",
        "",
        "<current-instruction>",
        "what now?",
        "</current-instruction>",
      ].join("\n"),
    );
  });

  it("does not wrap structured thread transcript context again", () => {
    const transcript = [
      "<thread-transcript>",
      '  <message index="1" ts="2026-05-31T00:00:00.000Z" role="user" author="alice">',
      "alice: budget is due Friday",
      "  </message>",
      "</thread-transcript>",
    ].join("\n");

    expect(buildUserTurnText("what now?", transcript)).toBe(
      [
        transcript,
        "",
        "<current-instruction>",
        "what now?",
        "</current-instruction>",
      ].join("\n"),
    );
  });
});

describe("buildUserTurnInput", () => {
  it("adds text attachment previews to router-only blocks", () => {
    const input = buildUserTurnInput({
      omittedImageAttachmentCount: 0,
      userTurnText: "can you fix this?",
      userAttachments: [
        {
          data: Buffer.from("TypeError: x is undefined\nat respond.ts:42"),
          filename: "error.txt",
          mediaType: "text/plain",
        },
      ],
    });

    expect(input.routerBlocks).toEqual([
      [
        "<attachment>",
        "filename: error.txt",
        "media_type: text/plain",
        "<text-preview>",
        "TypeError: x is undefined\nat respond.ts:42",
        "</text-preview>",
        "</attachment>",
      ].join("\n"),
    ]);
    expect(input.userContentParts).toEqual([
      { type: "text", text: "can you fix this?" },
      {
        type: "text",
        text: expect.stringContaining("encoding: base64"),
      },
    ]);
  });

  it("previews structured suffix media types for routing", () => {
    const input = buildUserTurnInput({
      omittedImageAttachmentCount: 0,
      userTurnText: "can you fix this?",
      userAttachments: [
        {
          data: Buffer.from('{"error":"TypeError: x is undefined"}'),
          filename: "error.json",
          mediaType: "application/vnd.api+json; charset=utf-8",
        },
      ],
    });

    expect(input.routerBlocks[0]).toContain(
      '{"error":"TypeError: x is undefined"}',
    );
    expect(input.routerBlocks[0]).toContain(
      "media_type: application/vnd.api+json; charset=utf-8",
    );
  });

  it("records omitted image notices for the prompt and router", () => {
    const input = buildUserTurnInput({
      omittedImageAttachmentCount: 2,
      userTurnText: "what is in these images?",
    });

    expect(input.routerBlocks).toHaveLength(1);
    expect(input.routerBlocks[0]).toContain("<omitted-image-attachments>");
    expect(input.routerBlocks[0]).toContain("count: 2");
    expect(input.userContentParts).toEqual([
      { type: "text", text: "what is in these images?" },
      {
        type: "text",
        text: expect.stringContaining("<omitted-image-attachments>"),
      },
    ]);
  });
});
