import { eq } from "drizzle-orm";
import { userCustomizationTextSchema } from "@/api/schema/user-customization";
import { getDb } from "@/chat/db";
import { juniorUsers } from "@/db/schema";

/** Read the saved customization for one user. */
export async function readUserCustomization(
  userId: string,
): Promise<string | undefined> {
  const rows = await getDb()
    .select({ customization: juniorUsers.customization })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return rows[0]?.customization ?? undefined;
}

/**
 * Save or clear the customization for one user. Returns false when the user
 * does not exist.
 */
export async function saveUserCustomization(
  userId: string,
  customization: string,
): Promise<boolean> {
  const text = userCustomizationTextSchema.parse(customization);
  const rows = await getDb()
    .update(juniorUsers)
    .set({ customization: text || null, updatedAt: new Date() })
    .where(eq(juniorUsers.id, userId))
    .returning({ id: juniorUsers.id });
  return rows.length > 0;
}
