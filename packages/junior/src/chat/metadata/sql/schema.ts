import {
  juniorConversationInboundMessages,
  juniorConversations,
} from "./schema/conversations";
import { juniorDestinations } from "./schema/destinations";
import { juniorIdentities } from "./schema/identities";
import { juniorSchemaMigrations } from "./schema/migrations";

export {
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
};

export const conversationMetadataSqlSchema = {
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
};
