export {
  conversationDetailReportSchema,
  conversationFeedSchema,
  conversationStatsReportSchema,
  conversationSubagentTranscriptReportSchema,
} from "./conversations/schema";
export type {
  ActorIdentity,
  ConversationActivityReport,
  ConversationActivityStatus,
  ConversationContextEvent,
  ConversationCost,
  ConversationDetailReport,
  ConversationFeed,
  ConversationReportStatus,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSubagentActivityReport,
  ConversationSubagentTranscriptReport,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationToolActivityReport,
  ConversationUsage,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartType,
  TranscriptRole,
} from "./conversations/schema";
export {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
} from "./people/schema";
export type {
  ActorActivityDayReport,
  ActorDirectoryReport,
  ActorProfileReport,
  ActorSummaryReport,
  ActorTotalsReport,
} from "./people/schema";
export {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginOperationalReportSchema,
  pluginPackageContentItemReportSchema,
  pluginPackageContentReportSchema,
  pluginReportSchema,
  pluginReportsSchema,
  runtimeInfoReportSchema,
  skillReportSchema,
  skillReportsSchema,
} from "../reporting-schema";
export type {
  HealthReport,
  PluginOperationalReport,
  PluginOperationalReportFeed,
  PluginPackageContentItemReport,
  PluginPackageContentReport,
  PluginReport,
  PluginReports,
  RuntimeInfoReport,
  SkillReport,
  SkillReports,
} from "../reporting-schema";
import { z } from "zod";

export const conversationParamsSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();
export const subagentParamsSchema = conversationParamsSchema
  .extend({ subagentId: z.string().min(1) })
  .strict();
export const personParamsSchema = z
  .object({ email: z.string().trim().min(1) })
  .strict();

export type ConversationParams = z.infer<typeof conversationParamsSchema>;
export type SubagentParams = z.infer<typeof subagentParamsSchema>;
export type PersonParams = z.infer<typeof personParamsSchema>;
