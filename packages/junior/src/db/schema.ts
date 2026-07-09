import { juniorAgentSteps } from "./schema/agent-steps";
import { juniorConversationMessages } from "./schema/conversation-messages";
import { juniorConversations } from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorSchemaMigrations } from "./schema/migrations";
import { juniorUsers } from "./schema/users";

export {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
  juniorUsers,
};
