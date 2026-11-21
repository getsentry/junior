import type { PluginState } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { sendConditionalRequest } from "../src/conditional-requests";

const URL = "https://api.github.com/repos/getsentry/junior/pulls/946";

function failingState(): PluginState {
  const fail = async () => {
    throw new Error("Redis is down");
  };
  return {
    delete: fail,
    get: fail,
    set: fail,
    setIfNotExists: fail,
    withLock: fail,
  };
}

describe("conditional GitHub reads", () => {
  it("reads GitHub as usual when plugin state fails", async () => {
    const sent: Array<Record<string, string>> = [];
    const response = await sendConditionalRequest(
      failingState(),
      URL,
      async (headers) => {
        sent.push(headers);
        return Response.json({ number: 946 }, { headers: { etag: 'W/"1"' } });
      },
    );

    expect(sent).toEqual([{}]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ number: 946 });
  });
});
