/** Read the internal-integration client secret used for issue webhook ingress. */
export function sentryWebhookSecret(): string | undefined {
  return process.env.SENTRY_WEBHOOK_SECRET?.trim() || undefined;
}

/** Read the Sentry organization allowed to publish issue webhooks. */
export function sentryWebhookOrg(): string | undefined {
  return process.env.SENTRY_WEBHOOK_ORG?.trim().toLowerCase() || undefined;
}
