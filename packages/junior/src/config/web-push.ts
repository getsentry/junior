// The web push group: VAPID settings for web push notifications.
import * as z from "zod";
import type { Env } from "@/config/fields";

/** VAPID settings for web push notifications. */
export const webPushSchema = z
  .strictObject({
    privateKey: z.string().optional(),
    publicKey: z.string().optional(),
    subject: z.string().optional(),
  })
  .prefault({});

/** Read the web push group from env. */
export function readWebPushEnv(env: Env) {
  return {
    privateKey: env["JUNIOR_WEB_PUSH_PRIVATE_KEY"]?.trim(),
    publicKey: env["JUNIOR_WEB_PUSH_PUBLIC_KEY"]?.trim(),
    subject: env["JUNIOR_WEB_PUSH_SUBJECT"]?.trim(),
  };
}
