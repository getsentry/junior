import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { streamSimple, type Context } from "@earendil-works/pi-ai/compat";
import { startHandoffReplay } from "../../../src/handoff-replay";

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-ai/compat")>()),
  streamSimple: vi.fn(),
}));

describe("handoff replay boundary", () => {
  afterEach(() => vi.clearAllMocks());

  it("replays one tool call, then forwards continuation input to the provider", async () => {
    const provider = createFauxCore({ api: "test", provider: "test" });
    provider.setResponses([fauxAssistantMessage("Provider continuation")]);
    vi.mocked(streamSimple).mockImplementation(provider.streamSimple);
    const stream = startHandoffReplay();
    const model = provider.getModel();
    const context: Context = {
      messages: [{ role: "user", content: "Deslop", timestamp: 1 }],
      tools: [
        {
          name: "handoff",
          description: "Switch profiles",
          parameters: {
            type: "object",
            properties: { profile: { type: "string", enum: ["handoff"] } },
          },
        },
      ],
    };
    const options = { signal: new AbortController().signal };
    const first = await stream(model, context, options).result();
    expect(first.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "handoff",
        arguments: { profile: "handoff" },
      }),
    ]);
    expect(streamSimple).not.toHaveBeenCalled();

    const continuation: Context = {
      ...context,
      messages: [{ role: "user", content: "Generated summary", timestamp: 2 }],
    };
    const second = await stream(model, continuation, options).result();
    expect(streamSimple).toHaveBeenCalledExactlyOnceWith(
      model,
      continuation,
      options,
    );
    expect(second.content).toEqual([
      { type: "text", text: "Provider continuation" },
    ]);
  });
});
