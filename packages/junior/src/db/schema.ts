import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversations } from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorUsers } from "./schema/users";

export {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};

export const juniorSqlSchema = {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
};
