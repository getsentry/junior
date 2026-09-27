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
      "Read your live execution state: current model ID, profile, reasoning level, configured profiles, image-input support, and conversation/turn/run IDs. Use for questions about your model or which model handoff would use; do not answer from memory, repository defaults, or channel config. Does not switch models. Profile reasoningLevel is the effective level if selected now; configuredReasoningLevel is null when it inherits the active level. Returns a dated card with active-history context estimates, input budget and compaction threshold, last completed call cache usage, and completed main-model call usage and estimated USD costs in this execution slice. These are not full-turn or conversation totals; earlier slices, failed calls, and auxiliary models are excluded. Missing counters stay unknown. Context is the runtime estimate, not an exact next-request size. Cached input share is cached / (uncached + cached + written); it does not predict the next cache hit.",
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
      const { active, context, usage } = settings;
      const count = (value: number | null | undefined) =>
        value == null ? "Not recorded" : value.toLocaleString("en-US");
      const cost = usage.totals?.cost?.total;
      const last = usage.lastCall;
      const cacheShare = last?.cachedInputSharePercent;
      const metrics = [
        `Context estimate: ${count(context.estimatedTokens)} / ${count(context.inputLimitTokens)} input budget (${context.inputUtilizationPercent.toFixed(1)}%) · ${count(context.remainingInputTokens)} remaining`,
        `Model window: ${count(context.modelWindowTokens)} · compaction above ${count(context.compactionTriggerTokens)}${context.aboveCompactionThreshold ? " · threshold exceeded" : ""}`,
        `Completed main-model calls this slice: ${usage.completedCalls} · ${count(usage.totals?.totalTokens)} total tokens · estimated USD ${cost == null ? "Not recorded" : cost.toFixed(4)}`,
        `Slice tokens: ${count(usage.totals?.inputTokens)} uncached · ${count(usage.totals?.cachedInputTokens)} cached · ${count(usage.totals?.cacheCreationTokens)} written · ${count(usage.totals?.outputTokens)} output · ${count(usage.totals?.reasoningTokens)} reasoning (part of output)`,
        `Last call cache: ${count(last?.usage?.cachedInputTokens)} cached · ${count(last?.usage?.cacheCreationTokens)} written · ${count(last?.usage?.inputTokens)} uncached · ${cacheShare == null ? "Not recorded" : `${cacheShare.toFixed(1)}%`} cached share`,
        ...(last
          ? [`Last call: ${last.modelId} · completed ${last.completedAt}`]
          : []),
        "Usage excludes earlier slices, failed calls, and auxiliary models. Context is an estimate, not an exact next-request size.",
      ];
      const description = [
        `Active: ${active.modelProfile} · ${active.modelId} · reasoning ${active.reasoningLevel}`,
        ...settings.profiles
          .filter((profile) => profile.modelProfile !== active.modelProfile)
          .map(
            (profile) =>
              `${profile.modelProfile}: ${profile.modelId} · reasoning ${profile.reasoningLevel}${profile.handoffAvailable ? "" : " · handoff unavailable"}`,
          ),
        `Image input: ${settings.supportsImageInput ? "supported" : "not supported"}`,
        ...metrics,
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
