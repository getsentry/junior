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

  it("keeps page targets on the compact shared shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/pages/page_123")) {
          return Response.json({
            id: "page_123",
            object: "page",
            url: "https://notion.so/page",
            last_edited_time: "2026-03-12T00:00:00.000Z",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Spec" }],
              },
            },
          });
        }

        if (url.endsWith("/pages/page_123/markdown")) {
          return new Response("# Spec", {
            headers: {
              "content-type": "text/plain",
            },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await fetchContent({
      id: "page_123",
      object: "page",
    });

    expect(result).toMatchObject({
      ok: true,
      target: {
        id: "page_123",
        object: "page",
        title: "Spec",
        url: "https://notion.so/page",
        last_edited_time: "2026-03-12T00:00:00.000Z",
      },
      content: {
        type: "page",
        markdown: "# Spec",
      },
    });
    expect(result.target).not.toHaveProperty("properties");
  });
});
