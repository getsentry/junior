import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";

type WebFetchToolServices = NonNullable<
  Parameters<typeof createWebFetchTool>[1]
>;

const passThroughTimeout: WebFetchToolServices["withTimeout"] = async (task) =>
  task;

describe("web fetch tool text responses", () => {
  const services = {
    assertPublicUrl: vi.fn(),
    fetchTextWithRedirects: vi.fn(),
    withTimeout: passThroughTimeout,
    extractWebFetchResponse: vi.fn(),
  } satisfies WebFetchToolServices;

  beforeEach(() => {
    services.assertPublicUrl.mockReset();
    services.fetchTextWithRedirects.mockReset();
    services.extractWebFetchResponse.mockReset();
  });

  it("uses a single fetch path for non-image responses", async () => {
    const safeUrl = new URL("https://example.com/article");
    services.assertPublicUrl.mockResolvedValue(safeUrl);
    services.fetchTextWithRedirects.mockResolvedValue(
      new Response("<html><body>hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    services.extractWebFetchResponse.mockResolvedValue({
      url: safeUrl.toString(),
      content: "hello",
    });

    const tool = createWebFetchTool({}, services);
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/article", max_chars: 1200 },
      {} as never,
    );

    expect(result).toEqual({ url: safeUrl.toString(), content: "hello" });
    expect(services.assertPublicUrl).toHaveBeenCalledTimes(1);
    expect(services.fetchTextWithRedirects).toHaveBeenCalledTimes(1);
    expect(services.extractWebFetchResponse).toHaveBeenCalledTimes(1);
    expect(services.extractWebFetchResponse).toHaveBeenCalledWith(
      safeUrl,
      expect.any(Response),
      1200,
    );
  });
});
