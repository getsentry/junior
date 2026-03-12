import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchContent } from "../../../junior-notion/skills/notion/scripts/notion-cli.mjs";

describe("notion cli fetchContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves data source metadata when the rows query fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/data_sources/ds_123") && (init?.method === undefined || init.method === "GET")) {
        return Response.json({
          id: "ds_123",
          object: "data_source",
          title: [{ plain_text: "Roadmap" }],
          url: "https://notion.so/roadmap",
          last_edited_time: "2026-03-12T00:00:00.000Z",
          properties: {},
        });
      }

      if (url.endsWith("/data_sources/ds_123/query")) {
        return new Response("query failed", { status: 500 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchContent({
      id: "ds_123",
      object: "data_source",
      rowLimit: 5,
    });

    expect(result).toMatchObject({
      ok: true,
      target: {
        id: "ds_123",
        object: "data_source",
        title: "Roadmap",
        url: "https://notion.so/roadmap",
        last_edited_time: "2026-03-12T00:00:00.000Z",
      },
      content: null,
    });
    expect(result.content_error).toContain("Notion API POST /data_sources/ds_123/query failed with 500");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/data_sources/ds_123"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/data_sources/ds_123/query"))).toHaveLength(3);
  });
});
