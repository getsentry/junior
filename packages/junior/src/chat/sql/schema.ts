export {
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
} from "@/chat/metadata/sql/schema";
import { schema as metadataSchema } from "@/chat/metadata/sql/schema";

export const juniorSqlSchema = {
  ...metadataSchema,
};
