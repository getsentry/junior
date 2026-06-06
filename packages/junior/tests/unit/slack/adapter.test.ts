import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSlackAdapterMock } = vi.hoisted(() => ({
  createSlackAdapterMock: vi.fn(),
}));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: createSlackAdapterMock,
}));

import { createJuniorSlackAdapter } from "@/chat/slack/adapter";

describe("createJuniorSlackAdapter", () => {
  beforeEach(() => {
    createSlackAdapterMock.mockReset();
  });

  it("delegates to the upstream adapter without patching private internals", () => {
    const adapter = { id: "adapter" };
    createSlackAdapterMock.mockReturnValue(adapter);

    expect(createJuniorSlackAdapter()).toBe(adapter);
    expect(createSlackAdapterMock).toHaveBeenCalledOnce();
  });
});
