/** Read the secret used to verify Linear webhook deliveries. */
export function linearWebhookSecret(): string | undefined {
  return process.env.LINEAR_WEBHOOK_SECRET?.trim() || undefined;
}
