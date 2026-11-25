import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

// One stored sign-in. The dashboard keeps its token in a cookie, and the iOS
// app sends it as a bearer token. Only the SHA-256 hash of the token is
// stored, so a database read cannot sign anyone in.
export const juniorSignInSessions = pgTable(
  "junior_sign_in_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userEmailNormalized: text("user_email_normalized").notNull(),
    userName: text("user_name"),
    /** `web` or `ios`. It sets the lifetime and nothing else. */
    client: text("client").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    uniqueIndex("junior_sign_in_sessions_token_hash_uidx").on(table.tokenHash),
    index("junior_sign_in_sessions_user_email_idx").on(
      table.userEmailNormalized,
    ),
  ],
);
