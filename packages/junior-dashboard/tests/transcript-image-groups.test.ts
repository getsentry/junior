import { describe, expect, it } from "vitest";

import { transcriptImageGroups } from "../src/client/conversations/TranscriptAttachment";
import type { TranscriptViewMessage } from "../src/client/types";

function image(id: string) {
  return { id, filename: `${id}.png`, contentType: "image/png", bytes: 10 };
}

function user(seq: number, ids: string[] = []): TranscriptViewMessage {
  return {
    attachments: ids.map(image),
    parts: [{ type: "text", text: "hi" }],
    role: "user",
    sourceSeq: seq,
  };
}

function delivered(seq: number, ids: string[]): TranscriptViewMessage {
  return {
    parts: [{ type: "attachments_delivered", attachments: ids.map(image) }],
    role: "system",
    sourceSeq: seq,
  };
}

function filenames(messages: TranscriptViewMessage[]) {
  return transcriptImageGroups("c1", messages).map((group) =>
    group.map((entry) => entry.filename),
  );
}

describe("transcriptImageGroups", () => {
  it("groups the images of one response across deliveries", () => {
    expect(
      filenames([
        user(0, ["sent"]),
        delivered(1, ["a", "b"]),
        delivered(2, ["c"]),
        user(3),
        delivered(4, ["d"]),
      ]),
    ).toEqual([["sent.png"], ["a.png", "b.png", "c.png"], ["d.png"]]);
  });

  it("keeps a response open across a context message", () => {
    expect(
      filenames([
        user(0),
        delivered(1, ["a"]),
        { ...user(2), context: true },
        delivered(3, ["b"]),
      ]),
    ).toEqual([["a.png", "b.png"]]);
  });
});
