import {
  OBJECT_FACTS_MAX_BYTES,
  objectFactsBytes,
  type ObjectAnnotation,
  type ObjectFacts,
} from "@sentry/junior-plugin-api";
import { lexer, walkTokens } from "marked";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
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

type HtmlNode =
  | DefaultTreeAdapterMap["parentNode"]
  | DefaultTreeAdapterMap["childNode"];

// Read `<img src>` with an HTML parser, so a `src=` inside another attribute
// value is not read as the image.
function htmlImageSources(html: string): string[] {
  const sources: string[] = [];
  const visit = (node: HtmlNode) => {
    if ("tagName" in node && node.tagName === "img") {
      const src = node.attrs.find((attr) => attr.name === "src")?.value;
      if (src) sources.push(src);
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(parseFragment(html));
  return sources;
}

// Images that GitHub stores for a description. The id names fixed bytes.
const GITHUB_ATTACHMENT_PATH = /^\/user-attachments\/assets\/[0-9a-f-]{36}$/i;

/**
 * Return where a description image is stored, or nothing when Junior does
 * not serve it. The dashboard loads each one through the Junior image route:
 * - `artifact`: Junior's own public artifacts, under `JUNIOR_BASE_URL`.
 * - `attachment`: `github.com/user-attachments/assets/<id>` images. They
 *   need the GitHub App credential on private repositories, and GitHub
 *   redirects them to a short-lived signed URL. Junior never saves the
 *   signed `private-user-images.githubusercontent.com` URL, because it
 *   expires in minutes.
 */
export function githubImageKind(
  url: URL,
): "artifact" | "attachment" | undefined {
  if (url.username || url.password || url.href.length > 512) return undefined;
  if (
    url.origin === "https://github.com" &&
    !url.search &&
    GITHUB_ATTACHMENT_PATH.test(url.pathname)
  ) {
    return "attachment";
  }
  const baseUrl = process.env.JUNIOR_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl || !URL.canParse(`${baseUrl}/public/artifacts/`)) {
    return undefined;
  }
  const prefix = new URL(`${baseUrl}/public/artifacts/`);
  return (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === prefix.origin &&
    url.pathname.length > prefix.pathname.length &&
    url.pathname.startsWith(prefix.pathname)
    ? "artifact"
    : undefined;
}

function previewImageUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return githubImageKind(url) ? url.href : undefined;
}

/**
 * Return the images in a pull request body that Junior serves, in body
 * order, for card previews. Screenshots often come as a before and after
 * pair, so the dashboard chooses which one to show.
 */
export function githubPreviewImageUrls(
  body: string | null | undefined,
): string[] {
  const sources: string[] = [];
  void walkTokens(lexer(visibleBody(body), { gfm: true }), (token) => {
    // marked's generic token types `href` as `any`.
    // oxlint-disable-next-line typescript/no-unsafe-argument
    if (token.type === "image") sources.push(token.href);
    if (token.type === "html") sources.push(...htmlImageSources(token.raw));
  });
  return [
    ...new Set(
      sources
        .map(previewImageUrl)
        .filter((url): url is string => url !== undefined),
    ),
  ];
}

type CodeChangeFacts = Extract<ObjectFacts, { type: "code_change" }>;

/**
 * Add preview images in body order while the facts stay in the 4 KiB limit.
 * Images that do not fit are left out.
 */
export function withGitHubPreviewImages(
  facts: Omit<CodeChangeFacts, "previewImageUrls">,
  urls: readonly string[],
): CodeChangeFacts {
  // Serialize the other facts once. The list goes last in the JSON, as
  // `,"previewImageUrls":[...]`, so each URL adds its JSON string and a
  // comma. `URL.href` is ASCII, so its length is its size in bytes.
  let bytes = objectFactsBytes(facts) + ',"previewImageUrls":[]'.length;
  const previewImageUrls: string[] = [];
  for (const url of urls) {
    bytes += JSON.stringify(url).length + (previewImageUrls.length ? 1 : 0);
    if (bytes > OBJECT_FACTS_MAX_BYTES) break;
    previewImageUrls.push(url);
  }
  return previewImageUrls.length > 0 ? { ...facts, previewImageUrls } : facts;
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
        ? withGitHubPreviewImages(
            {
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
            },
            githubPreviewImageUrls(data.body),
          )
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
