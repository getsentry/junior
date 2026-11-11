// LOCAL COST-RUN ONLY. Do not commit. Reads code changes with this sandbox's
// GitHub token because the dev server has no GitHub App credentials.
import { githubCodeChangeHooks as hooks } from "./local-code-changes-impl.ts";

const egress = {
  fetch: async ({ request }: { request: Request }) => {
    const headers = new Headers(request.headers);
    headers.set("authorization", `token ${process.env.GITHUB_TOKEN}`);
    return await fetch(new Request(request, { headers }));
  },
};
const wrap = <T extends object>(ctx: T) => ({ ...ctx, egress }) as never;

export const localCodeChangesPlugin = {
  manifest: {
    name: "github-local",
    displayName: "GitHub (local cost runs)",
    description: "Reads code changes for local Walkthrough cost runs.",
  },
  hooks: {
    codeChanges: {
      readStack: (ctx: object) => hooks.readStack(wrap(ctx)),
      readDiff: (ctx: object) => hooks.readDiff(wrap(ctx)),
      readFile: (ctx: object) => hooks.readFile(wrap(ctx)),
    },
  },
} as never;
