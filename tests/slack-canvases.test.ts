import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@/chat/slack-actions/canvases";

const mockWithSlackRetries = vi.fn(async <T>(task: () => Promise<T>) => task());
const mockGetFilePermalink = vi.fn(async (_fileId: string) => undefined as string | undefined);

const mockClient = {
  canvases: {
    create: vi.fn(),
    sections: {
      lookup: vi.fn()
    },
    edit: vi.fn()
  },
  conversations: {
    canvases: {
      create: vi.fn()
    }
  }
};

vi.mock("@/chat/slack-actions/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/slack-actions/client")>();
  return {
    ...actual,
    getSlackClient: () => mockClient,
    withSlackRetries: (task: () => Promise<unknown>) => mockWithSlackRetries(task),
    getFilePermalink: (fileId: string) => mockGetFilePermalink(fileId)
  };
});

describe("createCanvas", () => {
  beforeEach(() => {
    mockClient.canvases.create.mockResolvedValue({ canvas_id: "F1" });
    mockClient.conversations.canvases.create.mockResolvedValue({ canvas_id: "F2" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses conversations.canvases.create for DM channels", async () => {
    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "D12345"
    });

    expect(mockClient.conversations.canvases.create).toHaveBeenCalledWith({
      channel_id: "D12345",
      title: "Title",
      document_content: {
        type: "markdown",
        markdown: "Body"
      }
    });
    expect(mockClient.canvases.create).not.toHaveBeenCalled();
    expect(created.canvasId).toBe("F2");
  });

  it("uses conversations.canvases.create for C/G channels", async () => {
    await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "C12345"
    });

    expect(mockClient.conversations.canvases.create).toHaveBeenCalledWith({
      channel_id: "C12345",
      title: "Title",
      document_content: {
        type: "markdown",
        markdown: "Body"
      }
    });
    expect(mockClient.canvases.create).not.toHaveBeenCalled();
  });

  it("uses canvases.create when channel id is not provided", async () => {
    await createCanvas({
      title: "Title",
      markdown: "Body"
    });

    expect(mockClient.canvases.create).toHaveBeenCalledTimes(1);
    expect(mockClient.conversations.canvases.create).not.toHaveBeenCalled();
  });
});
