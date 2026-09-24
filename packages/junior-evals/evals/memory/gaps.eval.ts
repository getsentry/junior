import { expect } from "vitest";
import { createHarness, describeEval } from "vitest-evals";
import { createPluginModel } from "@/chat/plugins/model";
import {
  createWebSource,
  type PluginRunTranscriptEntry,
} from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "../../../junior-memory/src/agent";

// Exercise the production extraction boundary, not the main assistant's choice
// of tools. Fixed storage and access rules belong to the memory storage suite.
const harness = createHarness<
  PluginRunTranscriptEntry[],
  {
    gaps: {
      category: string;
      impact: string;
      description: string;
      explanation: string;
    }[];
    memories: string[];
  }
>({
  name: "gap-extraction",
  async run({ input, signal }) {
    const result = await createMemoryAgent(
      createPluginModel("memory", { structuredModel: "default" }, { signal }),
    ).extractSessionMemories({
      actors: [{ platform: "web", userId: "gap-eval-user" }],
      existingMemories: [],
      runtimeContext: {
        conversationId: "gap-eval-conversation",
        actor: { platform: "web", userId: "gap-eval-user" },
        source: createWebSource("gap-eval-conversation", "private"),
        userId: "gap-eval-user",
      },
      transcript: input.map((entry) => ({ ...entry, text: entry.text ?? "" })),
    });
    return {
      events: [
        { type: "message", role: "user", content: JSON.stringify(input) },
        {
          type: "message",
          role: "assistant",
          content: JSON.stringify(result.gaps),
        },
      ],
      output: {
        gaps: result.gaps,
        memories: result.memories.map((memory) => memory.content),
      },
    };
  },
});

function request(text: string): PluginRunTranscriptEntry {
  return {
    type: "message",
    role: "user",
    text,
    isRunActor: true,
    provenance: {
      authority: "instruction",
      actor: { platform: "web", userId: "gap-eval-user" },
    },
  };
}
function reply(text: string): PluginRunTranscriptEntry {
  return { type: "message", role: "assistant", text };
}

describeEval(
  "Gap observations",
  { harness, judges: [], judgeThreshold: null },
  (it) => {
    it("captures a permission blocker without retaining sensitive inputs", async ({
      run,
    }) => {
      const result = await run([
        request(
          "Read the monthly invoice for account customer-private-417. The supplied access token is fictional-secret-852.",
        ),
        {
          type: "toolResult",
          toolName: "readInvoice",
          isError: true,
          text: "403: invoice read permission denied",
        },
        reply(
          "I could not read the invoice because the connected account lacks invoice read permission.",
        ),
      ]);
      expect(result.output.gaps).toEqual([
        expect.objectContaining({ category: "permission", impact: "blocked" }),
      ]);
      expect(JSON.stringify(result.output)).not.toMatch(
        /customer-private-417|fictional-secret-852/,
      );
      expect(result.output.memories).toEqual([]);
    });

    it("does not log a recovered transient failure", async ({ run }) => {
      const result = await run([
        request("Get the current build status."),
        {
          type: "toolResult",
          toolName: "getBuild",
          isError: true,
          text: "503: temporarily unavailable",
        },
        {
          type: "toolResult",
          toolName: "getBuild",
          isError: false,
          text: "Build succeeded.",
        },
        reply("The build succeeded."),
      ]);
      expect(result.output.gaps).toEqual([]);
    });

    it("keeps an unsupported assistant limitation claim unverified", async ({
      run,
    }) => {
      const result = await run([
        request("Find the planning meeting transcript."),
        reply("I cannot access meeting transcripts. Please upload it here."),
      ]);
      expect(result.output.gaps).toHaveLength(1);
      expect(result.output.gaps[0]!.explanation).toMatch(
        /unverified|not verified|no tool|without.*evidence|claim/i,
      );
      expect(result.output.memories).toEqual([]);
    });
  },
);
