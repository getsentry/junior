/** Read the normalized secret shared by Sentry webhook ingress and catalog enablement. */
export function sentryWebhookSecret(): string | undefined {
  return process.env.SENTRY_WEBHOOK_SECRET?.trim() || undefined;
}
