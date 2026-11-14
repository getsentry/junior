// Only this module reads signing and encryption secrets from the environment,
// so one file shows what code can touch keys (see `policies/security.md`).
// `ast-grep/rules/no-secret-env-reads-outside-secrets-module.yml` enforces it.
// The encryption keyring is the one exception: `chat/config.ts` passes the
// startup env to `readEncryptionKeyring` in `chat/encryption/keyring.ts`, and
// the rule still blocks direct `process.env` reads of its keys.

/** Read the server secret that signs internal tokens and payloads. */
export function readJuniorSecret(): string | undefined {
  return process.env["JUNIOR_SECRET"]?.trim() || undefined;
}

/** Read the raw dashboard session secret, with `JUNIOR_SECRET` as fallback. */
export function readSignInSecret(): string | undefined {
  return process.env["BETTER_AUTH_SECRET"] ?? process.env["JUNIOR_SECRET"];
}

/** Read the bearer secret that internal cron requests must send. */
export function readSchedulerSecret(): string | undefined {
  return (
    process.env["JUNIOR_SCHEDULER_SECRET"]?.trim() ||
    process.env["CRON_SECRET"]?.trim()
  );
}

/** Read the VAPID private key that signs web push messages. */
export function readWebPushPrivateKey(): string | undefined {
  return process.env["JUNIOR_WEB_PUSH_PRIVATE_KEY"]?.trim();
}
