import { juniorConversationAnnotations } from "./schema/conversation-annotations";
import { juniorApiTokens } from "./schema/api-tokens";
import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversationBindings } from "./schema/conversation-bindings";
import { juniorConversations } from "./schema/conversations";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
} from "./schema/agent-invocations";
import { juniorLocationConfigurations } from "./schema/location-configurations";
import { juniorDestinations } from "./schema/destinations";
import { juniorEventTasks } from "./schema/event-tasks";
import { juniorIdentities } from "./schema/identities";
import { juniorStats } from "./schema/stats";
import { juniorTaskExecutions } from "./schema/task-executions";
import {
  juniorSchedulerRuns,
  juniorSchedulerTasks,
} from "./schema/scheduled-tasks";
import { juniorUsers } from "./schema/users";

export {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversationEvents,
  juniorConversationBindings,
  juniorConversations,
  juniorLocationConfigurations,
  juniorDestinations,
  juniorEventTasks,
  juniorIdentities,
  juniorStats,
  juniorTaskExecutions,
  juniorSchedulerRuns,
  juniorSchedulerTasks,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversationEvents,
  juniorConversationBindings,
  juniorConversations,
  juniorLocationConfigurations,
  juniorDestinations,
  juniorEventTasks,
  juniorIdentities,
  juniorStats,
  juniorTaskExecutions,
  juniorSchedulerRuns,
  juniorSchedulerTasks,
  juniorUsers,
};
