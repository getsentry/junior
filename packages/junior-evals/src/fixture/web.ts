/**
 * Web page replay for the agent test fixture.
 *
 * The `webFetch` tool reads public web pages, which change and can be down.
 * This module records each response with vitest-evals replay and answers
 * later requests from the recording. The recordings are in
 * `.vitest-evals/recordings/webFetch/`. `pnpm evals:record` records them
 * again.
 */
import { bypass, http, HttpResponse } from "msw";
import { executeWithReplay } from "vitest-evals/replay";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { mswServer } from "@junior-tests/msw/server";

/** One recorded response. A redirect has a `location` and no body. */
type RecordedResponse = {
  body: string;
  /** `base64` for a body that is not text, such as an image. */
  bodyEncoding: "base64" | "utf8";
  contentType: string | null;
  location: string | null;
  status: number;
};

/** Install the web page replay for the current test. */
export function installWebReplay(): void {
  mswServer.use(
    http.get("*", async ({ request }) => {
      // Only `webFetch` sends this user agent. Other requests go to the
      // handlers below.
      if (request.headers.get("user-agent") !== USER_AGENT) return undefined;
      const { result } = await executeWithReplay({
        toolName: "webFetch",
        args: { url: request.url },
        context: null,
        // `webFetch` follows redirects itself, so each one is its own request.
        execute: async (): Promise<RecordedResponse> => {
          const response = await fetch(bypass(request, { redirect: "manual" }));
          const contentType = response.headers.get("content-type");
          const isText = /^text\/|json|xml/i.test(contentType ?? "");
          return {
            body: isText
              ? await response.text()
              : Buffer.from(await response.arrayBuffer()).toString("base64"),
            bodyEncoding: isText ? "utf8" : "base64",
            contentType,
            location: response.headers.get("location"),
            status: response.status,
          };
        },
        replay: { version: "web-page-v1" },
      });
      return new HttpResponse(
        result.bodyEncoding === "base64"
          ? Buffer.from(result.body, "base64")
          : result.body,
        {
          status: result.status,
          headers: {
            ...(result.contentType
              ? { "content-type": result.contentType }
              : undefined),
            ...(result.location ? { location: result.location } : undefined),
          },
        },
      );
    }),
  );
}
