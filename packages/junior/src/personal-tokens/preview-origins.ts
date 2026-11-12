/**
 * Previews that may receive a personal token from the dashboard.
 *
 * A Preview host such as `sb-*.vercel.run` can belong to anyone, so a host
 * pattern cannot say which Previews are safe. Junior records each Preview
 * that it creates, with the email of the person who asked for it. Only that
 * person can send a token to it, and only until the record expires.
 */
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";

// Longer than a Sandbox runs. The URL stops working when the Sandbox stops.
const PREVIEW_ORIGIN_TTL_MS = 24 * 60 * 60 * 1_000;

const previewOriginRecordSchema = z
  .object({ ownerEmailNormalized: z.string() })
  .strict();

function previewOriginKey(origin: string): string {
  return `junior:preview-origin:v1:${origin}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Record that one person asked Junior for the Preview at `url`. */
export async function recordPreviewOrigin(args: {
  ownerEmail: string;
  url: string;
}): Promise<void> {
  await getStateAdapter().set(
    previewOriginKey(new URL(args.url).origin),
    previewOriginRecordSchema.parse({
      ownerEmailNormalized: normalizeEmail(args.ownerEmail),
    }),
    PREVIEW_ORIGIN_TTL_MS,
  );
}

/** Return true when Junior made the Preview at `origin` for this person. */
export async function previewOriginBelongsTo(args: {
  email: string;
  origin: string;
}): Promise<boolean> {
  const value = await getStateAdapter().get(previewOriginKey(args.origin));
  if (value === null) return false;
  return (
    previewOriginRecordSchema.parse(value).ownerEmailNormalized ===
    normalizeEmail(args.email)
  );
}
