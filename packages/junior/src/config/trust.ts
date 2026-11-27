// The trust group: who Junior accepts as the person they say they are.
// `chat/identities/trust` makes the decision with it.
import * as z from "zod";
import { parseEnvList } from "@/config/env-list";

/** The `createApp` settings that decide who is trusted. */
export const trustSchema = z
  .strictObject({
    /** `createApp({ slack: { allowedBotUserIds } })`: trusted without a profile email. */
    allowedBotUserIds: z.array(z.string()).default([]),
    /** `createApp({ allowedDomains })`. Unset falls back to `JUNIOR_ALLOWED_DOMAINS`. */
    allowedDomains: z.array(z.string()).optional(),
  })
  .prefault({});

/**
 * Resolve the allowed domains: the `createApp` option when set, else
 * `JUNIOR_ALLOWED_DOMAINS`. An empty list allows every domain.
 */
export function deriveTrust(
  trust: z.output<typeof trustSchema>,
  allowedDomainsEnv: string | undefined,
) {
  return {
    allowedBotUserIds: trust.allowedBotUserIds,
    allowedDomains: [
      ...new Set(
        (
          trust.allowedDomains ??
          parseEnvList("JUNIOR_ALLOWED_DOMAINS", allowedDomainsEnv) ??
          []
        )
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
  };
}
