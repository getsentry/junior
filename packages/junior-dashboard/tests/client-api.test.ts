import { afterEach, describe, expect, it, vi } from "vitest";
import { readConversationData } from "../src/client/api";

describe("dashboard client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarts Google sign-in when product API auth expires", async () => {
    const assign = vi.fn();
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "?filter=recent",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 401",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123",
      { credentials: "same-origin" },
    );
    expect(assign).toHaveBeenCalledWith(
      "/auth/login?next=%2Fconversations%3Ffilter%3Drecent",
    );
  });

  it("does not redirect for non-auth product API failures", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 403",
    );

    expect(assign).not.toHaveBeenCalled();
  });
});
