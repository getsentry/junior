import { describe, expect, it } from "vitest";

import { memoryPageRecord } from "../src/client/pages/memory/memoryRecord";

describe("memory permalink record", () => {
  it("projects the direct memory response into drawer content", () => {
    expect(
      memoryPageRecord({
        content: "Use pnpm.",
        createdAt: "2026-08-06T00:00:00.000Z",
        id: "memory/1",
        kind: "preference",
        observedAt: "2026-08-05T00:00:00.000Z",
        origin: "explicit",
        sourcePlatform: "slack",
      }),
    ).toMatchObject({
      actions: [
        {
          href: "/api/plugins/memory/memories/memory%2F1",
          tone: "danger",
        },
      ],
      id: "memory/1",
      metadata: expect.arrayContaining([
        { label: "Learned", value: "Explicit" },
      ]),
      title: "Use pnpm.",
    });
  });

  it("accepts dashboard web source platform on permalink loads", () => {
    expect(
      memoryPageRecord({
        content: "Prefers short dashboard answers.",
        createdAt: "2026-08-06T00:00:00.000Z",
        id: "memory/api-1",
        kind: "preference",
        observedAt: "2026-08-05T00:00:00.000Z",
        origin: "automatic",
        sourcePlatform: "web",
      }),
    ).toMatchObject({
      id: "memory/api-1",
      metadata: expect.arrayContaining([
        { label: "Source", value: "Web" },
        { label: "Learned", value: "Automatic" },
      ]),
      title: "Prefers short dashboard answers.",
    });
  });

  it("confirms that forgetting removes the memory for everyone", () => {
    expect(
      memoryPageRecord({
        content: "Deploys happen on Tuesdays.",
        createdAt: "2026-08-06T00:00:00.000Z",
        id: "memory/public-1",
        kind: "knowledge",
        observedAt: "2026-08-05T00:00:00.000Z",
        origin: "automatic",
        sourcePlatform: "slack",
      }),
    ).toMatchObject({
      actions: [
        {
          confirmation: "Forget this memory for everyone?",
          href: "/api/plugins/memory/memories/memory%2Fpublic-1",
          tone: "danger",
        },
      ],
      id: "memory/public-1",
    });
  });
});
