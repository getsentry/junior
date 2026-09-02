export const observations = {
  afterHandoffModelId: "",
  afterHandoffMessages: [] as Array<{
    role?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>,
  afterHandoffProfiles: [] as string[],
  afterHandoffToolNames: [] as string[],
  initialModelId: "",
  initialImagePart: undefined as
    | { type: unknown; data: unknown; mimeType: unknown }
    | undefined,
  initialHandoffProfiles: [] as string[],
  initialToolNames: [] as string[],
  mixedBatch: false,
  progressTool: false,
  providerCalls: 0,
  routerCalls: 0,
  requestedProfile: "handoff" as string | null | undefined,
  requestedProfileSequence: [] as string[],
  requestHandoffAfterRouting: false,
  routedModelProfile: "standard",
  routedReasoningLevel: "high",
  reasoningLevels: [] as string[],
  summaryCalls: 0,
  summaryAborted: false,
  summaryPending: false,
  handoffStatusBeforeSummary: false,
  statuses: [] as string[],
};
