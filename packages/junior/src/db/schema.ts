import { juniorConversationAnnotations } from "./schema/conversation-annotations";
import { juniorApiTokens } from "./schema/api-tokens";
import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversations } from "./schema/conversations";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
} from "./schema/agent-invocations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorStats } from "./schema/stats";
import { juniorUsers } from "./schema/users";

export {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorStats,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorStats,
  juniorUsers,
};
