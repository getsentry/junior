import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { lexer, walkTokens } from "marked";
import * as z from "zod";

const person = z.object({ login: z.string() });
const responseSchema = z.object({
  body: z.string().nullable().optional(),
  user: person.nullable().optional(),
  requested_reviewers: z.array(person).optional(),
  assignees: z.array(person).optional(),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string() })]))
    .optional(),
  head: z.object({ ref: z.string() }).optional(),
  base: z.object({ ref: z.string() }).optional(),
  mergeable: z.boolean().nullable().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
const short = (value: string | undefined) => {
  const text = value?.trim();
  return text ? (text.length > 64 ? `${text.slice(0, 63)}…` : text) : undefined;
};

/** Remove Junior's footers and HTML comments from a GitHub body. */
function visibleBody(body: string | null | undefined): string {
  let text = (body ?? "").replace(
    /<!-- junior-(session-footer|request-attribution):start -->[\s\S]*?<!-- junior-\1:end -->/g,
    "",
  );
  // Removing a comment can form another <!-- opener.
  while (text.includes("<!--")) {
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  }
  return text.trim();
}

function description(body: string | null | undefined): string | undefined {
  const text = visibleBody(body);
  if (!text) return undefined;
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}

// An HTML block can hold more than one image.
const HTML_IMAGE_SRC = /<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/gi;
// Facts must fit in 4 KiB, with the other code change facts.
const MAX_PREVIEW_IMAGES = 4;

/**
 * Keep only images that the dashboard can load without GitHub auth. GitHub
 * attachment URLs (`github.com/user-attachments/...` and
 * `private-user-images.githubusercontent.com`) need auth on private
 * repositories, so only Junior's own public artifacts, under the configured
 * `JUNIOR_BASE_URL`, qualify.
 */
function publicArtifactUrl(value: string): string | undefined {
  const baseUrl = process.env.JUNIOR_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return undefined;
  let url: URL;
  let prefix: URL;
  try {
    url = new URL(value);
    prefix = new URL(`${baseUrl}/public/artifacts/`);
  } catch {
    return undefined;
  }
  return (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === prefix.origin &&
    url.pathname.length > prefix.pathname.length &&
    url.pathname.startsWith(prefix.pathname) &&
    !url.username &&
    !url.password &&
    url.href.length <= 512
    ? url.href
    : undefined;
}

/**
 * Return the public images in a pull request body, in body order, for card
 * previews. Screenshots often come as a before and after pair, so the
 * dashboard chooses which one to show.
 */
export function githubPreviewImageUrls(
  body: string | null | undefined,
): string[] | undefined {
  const sources: string[] = [];
  walkTokens(lexer(visibleBody(body), { gfm: true }), (token) => {
    if (token.type === "image") sources.push(token.href);
    if (token.type === "html") {
      for (const match of token.raw.matchAll(HTML_IMAGE_SRC)) {
        sources.push(match[1]!);
      }
    }
  });
  const urls = [
    ...new Set(
      sources
        .map(publicArtifactUrl)
        .filter((url): url is string => url !== undefined),
    ),
  ];
  return urls.length > 0 ? urls.slice(0, MAX_PREVIEW_IMAGES) : undefined;
}

/** Select card facts from GitHub REST responses; never infer reviews or checks. */
export function githubObjectFacts(
  type: "task" | "code_change",
  response: unknown,
): Pick<ObjectAnnotation, "facts" | "sourceUpdatedAt" | "description"> {
  const data = responseSchema.parse(response);
  const result: Pick<
    ObjectAnnotation,
    "facts" | "sourceUpdatedAt" | "description"
  > = {
    sourceUpdatedAt: data.updated_at,
    description: description(data.body),
    facts:
      type === "code_change"
        ? {
            type,
            author: short(data.user?.login),
            reviewers: data.requested_reviewers
              ?.slice(0, 5)
              .map((user) => short(user.login)!)
              .filter(Boolean),
            sourceBranch: short(data.head?.ref),
            targetBranch: short(data.base?.ref),
            mergeable: data.mergeable ?? undefined,
            changedFiles: data.changed_files,
            additions: data.additions,
            deletions: data.deletions,
            previewImageUrls: githubPreviewImageUrls(data.body),
          }
        : {
            type,
            assignees: data.assignees
              ?.slice(0, 5)
              .map((user) => short(user.login)!)
              .filter(Boolean),
            labels: data.labels
              ?.slice(0, 5)
              .map(
                (label) =>
                  short(typeof label === "string" ? label : label.name)!,
              )
              .filter(Boolean),
          },
  };
  return result;
}
