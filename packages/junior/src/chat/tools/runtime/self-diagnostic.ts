import { randomUUID } from "node:crypto";
import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import {
  selfDiagnosticSchema,
  type SelfDiagnostic,
} from "@/chat/self-diagnostic";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Read active execution settings and attach their saved facts to the reply. */
export function createSelfDiagnosticTool(
  conversationId: string,
  readSelfDiagnostic: () => SelfDiagnostic,
) {
  return zodTool({
    description:
      "Read your live execution state: current model ID, profile, reasoning level, configured profiles, image-input support, and conversation/turn/run IDs. Use for questions about your model or which model handoff would use; do not answer from memory, repository defaults, or channel config. Does not switch models. Profile reasoningLevel is the effective level if selected now; configuredReasoningLevel is null when it inherits the active level. Returns a saved settings card; settings can change after this call. Token usage and costs are not included.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z.strictObject({}),
    outputSchema: selfDiagnosticSchema.extend({
      observedAt: z.iso.datetime(),
      objectCards: z.array(ownedObjectAnnotationSchema),
    }),
    execute: async () => {
      const settings = selfDiagnosticSchema.parse(readSelfDiagnostic());
      const observedAt = new Date().toISOString();
      const { active } = settings;
      const description = [
        `Active: ${active.modelProfile} · ${active.modelId} · reasoning ${active.reasoningLevel}`,
        ...settings.profiles
          .filter((profile) => profile.modelProfile !== active.modelProfile)
          .map(
            (profile) =>
              `${profile.modelProfile}: ${profile.modelId} · reasoning ${profile.reasoningLevel}${profile.handoffAvailable ? "" : " · handoff unavailable"}`,
          ),
        `Image input: ${settings.supportsImageInput ? "supported" : "not supported"}`,
        `Observed: ${observedAt}`,
        `Conversation: ${settings.conversationId}`,
        `Turn: ${settings.turnId}`,
        `Run: ${settings.runId ?? "Not recorded"}`,
      ].join("\n");
      // Each observation keeps its own facts. Later calls must not rewrite an
      // earlier Message card after a handoff or a deployment changes settings.
      const key = `self-diagnostic:${randomUUID()}`;
      return {
        ...settings,
        observedAt,
        objectCards: await saveObjectAnnotations(conversationId, "junior", [
          {
            kind: "object",
            objectType: "item",
            displayType: "Self diagnostic",
            key,
            title: active.modelId.slice(0, 512),
            label:
              `${active.modelProfile} · reasoning ${active.reasoningLevel}`.slice(
                0,
                256,
              ),
            url: getDashboardConversationLink(conversationId) ?? null,
            description: description.slice(0, 4000),
          },
        ]),
      };
    },
  });
}
