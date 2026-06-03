import { afterEach, describe, expect, it, vi } from "vitest";
import { readConversationData } from "../src/client/api";

describe("dashboard client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarts Google sign-in when dashboard API auth expires", async () => {
    const assign = vi.fn();
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/dashboard/conversations/slack%3AC1%3A123 returned 401",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/conversations/slack%3AC1%3A123",
      { credentials: "same-origin" },
    );
    expect(assign).toHaveBeenCalledWith("/api/dashboard/login");
  });

  it("does not redirect for non-auth dashboard API failures", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/dashboard/conversations/slack%3AC1%3A123 returned 403",
    );

    expect(assign).not.toHaveBeenCalled();
  });
});
