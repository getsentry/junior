import { juniorConversationAnnotations } from "./schema/conversation-annotations";
import { juniorApiTokens } from "./schema/api-tokens";
import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversations } from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorUsers } from "./schema/users";

export {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorConversationAnnotations,
  juniorApiTokens,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};
