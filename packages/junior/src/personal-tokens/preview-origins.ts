/**
 * Previews that may receive a personal token from the dashboard.
 *
 * A Preview host such as `sb-*.vercel.run` can belong to anyone, so a host
 * pattern cannot say which Previews are safe. Junior records each Preview
 * that it creates, with the email of each person who asked for it. Only those
 * people can send a token to it, and only until their record expires.
 */
import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY } from "@/chat/fan-out";
import { runBestEffort } from "@/chat/logging";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { getStateAdapter } from "@/chat/state/adapter";

// A Conversation resumes its named Sandbox with the same Preview URLs, and
// each resume renews the records. So a record only has to outlive one Sandbox
// session.
const PREVIEW_ORIGIN_TTL_MS = 24 * 60 * 60 * 1_000;

// One key per person, so a second person in the Conversation does not replace
// the first person's record.
function previewOriginKey(origin: string, email: string): string {
  return `junior:preview-origin:v2:${origin}:${email.trim().toLowerCase()}`;
}

/** Record that one person asked Junior for the Preview at `url`. */
export async function recordPreviewOrigin(args: {
  ownerEmail: string;
  url: string;
}): Promise<void> {
  await getStateAdapter().set(
    previewOriginKey(new URL(args.url).origin, args.ownerEmail),
    true,
    PREVIEW_ORIGIN_TTL_MS,
  );
}

/**
 * Renew the records of the Previews that a resumed Sandbox serves again, for
 * the person whose turn resumed it.
 */
export async function renewPreviewOrigins(
  sandbox: Pick<SandboxWorkspace, "previewUrls">,
  resolveOwner: () => Promise<{ email: string } | undefined>,
): Promise<void> {
  const urls = sandbox.previewUrls?.() ?? [];
  if (urls.length === 0) return;
  // The Sandbox works without the records: Connect then refuses the Preview,
  // and the viewer pastes a token instead.
  await runBestEffort(async () => {
    const owner = await resolveOwner();
    if (!owner) return;
    const limit = pLimit(FAN_OUT_CONCURRENCY);
    await Promise.all(
      urls.map((url) =>
        limit(() => recordPreviewOrigin({ ownerEmail: owner.email, url })),
      ),
    );
  }, "sandbox.preview_origin.renew.failed");
}

/** Return true when Junior made the Preview at `origin` for this person. */
export async function previewOriginBelongsTo(args: {
  email: string;
  origin: string;
}): Promise<boolean> {
  return (
    (await getStateAdapter().get(previewOriginKey(args.origin, args.email))) !==
    null
  );
}
