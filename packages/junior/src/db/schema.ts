import { juniorConversationEvents } from "./schema/conversation-events";
import { juniorConversationMessages } from "./schema/conversation-messages";
import { juniorConversations } from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorUsers } from "./schema/users";
import { juniorPendingDeliveries } from "./schema/pending-deliveries";

export {
  juniorConversationEvents,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
  juniorPendingDeliveries,
};

export const juniorSqlSchema = {
  juniorConversationEvents,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
  juniorPendingDeliveries,
};
