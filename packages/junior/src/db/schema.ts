import { juniorConversationAnnotations } from "./schema/conversation-annotations";
import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversations } from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorUsers } from "./schema/users";

export {
  juniorConversationAnnotations,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorConversationAnnotations,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};
