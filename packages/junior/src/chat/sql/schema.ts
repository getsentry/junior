export {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorSchemaMigrations,
} from "@/chat/conversations/sql/schema";
import { schema as conversationSchema } from "@/chat/conversations/sql/schema";

export const juniorSqlSchema = {
  ...conversationSchema,
};
