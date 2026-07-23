/** Read the normalized secret shared by watch creation and webhook ingress. */
export function vercelWebhookSecret(): string | undefined {
  return process.env.VERCEL_WEBHOOK_SECRET?.trim() || undefined;
}
