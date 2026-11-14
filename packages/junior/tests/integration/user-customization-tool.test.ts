import { afterEach, describe, expect, it } from "vitest";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { createLocalSource, type Identity } from "@sentry/junior-plugin-api";
import { closeDb } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { readUserCustomization } from "@/chat/identities/customization";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createTools } from "@/chat/tools";
import { createUpdateUserCustomizationTool } from "@/chat/tools/user-customization";
import { SUITE_EXPERIMENTAL } from "../fixtures/experimental-setup";

const CONVERSATION_ID = "local:user-customization:current";
const IDENTITY: Identity = {
  id: "identity-1",
  provider: "slack",
  providerSubjectId: "U123",
};

function context(
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    source: createLocalSource(CONVERSATION_ID),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
    turnTools: turnBehavior({
      kind: "root",
      personInput: true,
    }).tools,
    ...overrides,
  } as ToolRuntimeContext;
}

async function updateCustomization(
  runtime: ToolRuntimeContext,
  customization: string,
): Promise<unknown> {
  const tool = createUpdateUserCustomizationTool(runtime);
  if (!tool.execute || !tool.prepareArguments) {
    throw new Error("updateUserCustomization is missing");
  }
  return await tool.execute(tool.prepareArguments({ customization }), {});
}

describe("user customization tool", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("exists only when the app opts in, and never for child agents", () => {
    const toolNames = (runtime: ToolRuntimeContext): string[] =>
      Object.keys(createTools([], {}, runtime));
    expect(toolNames(context())).not.toContain("updateUserCustomization");

    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "user-customization": true,
    });
    expect(toolNames(context())).toContain("updateUserCustomization");
    expect(
      toolNames(
        context({
          parentConversationId: "local:user-customization:parent",
          turnTools: turnBehavior({
            kind: "task",
            personInput: false,
          }).tools,
        }),
      ),
    ).not.toContain("updateUserCustomization");
  });

  it("replaces the current user's text and rejects people without a user", async () => {
    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "user-customization": true,
    });
    const user = await resolveViewerUser("person@example.com");
    if (!user) throw new Error("missing user");
    const runtime = context({
      resolveActorIdentity: async () => ({ identity: IDENTITY, user }),
    });

    await updateCustomization(runtime, "Keep replies short.");
    expect(await readUserCustomization(user.id)).toBe("Keep replies short.");
    await updateCustomization(runtime, "");
    expect(await readUserCustomization(user.id)).toBeUndefined();

    await expect(
      updateCustomization(
        context({ resolveActorIdentity: async () => ({ identity: IDENTITY }) }),
        "Keep replies short.",
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
