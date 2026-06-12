export {
  conversationMetadataSqlSchema,
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
} from "@/chat/metadata/sql/schema";
import { conversationMetadataSqlSchema } from "@/chat/metadata/sql/schema";

export const juniorSqlSchema = {
  ...conversationMetadataSqlSchema,
};
