import type { PluginContext } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { SentryDb } from "../db/database.js";
import {
  activeSentryInstallations,
  removeSentryInstallation,
  saveSentryInstallation,
} from "./store.js";
import { exchangeSentryGrantCode, type SentryAppConfig } from "./tokens.js";

const installationWebhookSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("created"),
    data: z.object({
      installation: z.object({
        code: z.string().min(1),
        organization: z.object({ slug: z.string().min(1) }),
        uuid: z.string().min(1),
      }),
    }),
  }),
  z.object({
    action: z.literal("deleted"),
    data: z.object({
      installation: z.object({ uuid: z.string().min(1) }),
    }),
  }),
]);

/**
 * Apply one verified `installation` webhook of the public integration.
 * Return false for a payload that this plugin does not handle.
 *
 * Sentry sends the grant code only here, so a new installation saves its org
 * and exchanges the code before Junior acknowledges the webhook. The code
 * works once, so a retry of the same webhook does not exchange it again.
 */
export async function handleSentryInstallationWebhook(
  ctx: Pick<PluginContext, "cache" | "db">,
  config: SentryAppConfig,
  body: unknown,
): Promise<boolean> {
  const parsed = installationWebhookSchema.safeParse(body);
  if (!parsed.success) return false;
  const { installation } = parsed.data.data;
  const db = ctx.db as SentryDb;
  if (parsed.data.action === "created") {
    const { code, organization } = parsed.data.data.installation;
    const added = await saveSentryInstallation(db, {
      installationUuid: installation.uuid,
      orgSlug: organization.slug,
    });
    if (added) {
      await exchangeSentryGrantCode(ctx.cache, config, {
        code,
        installationUuid: installation.uuid,
      });
    }
  } else {
    await removeSentryInstallation(db, installation.uuid);
  }
  await activeSentryInstallations(ctx, { refresh: true });
  return true;
}
