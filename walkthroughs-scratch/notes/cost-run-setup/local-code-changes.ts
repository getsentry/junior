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
      // /tmp/walkthrough-head ("<number> <sha>") pins one layer to an older
      // commit, so one PR can play a stack before and after a push.
      readStack: async (ctx: object) => {
        const stack = await hooks.readStack(wrap(ctx));
        const pin = await import("node:fs/promises")
          .then((fs) => fs.readFile("/tmp/walkthrough-head", "utf8"))
          .catch(() => "");
        const [number, sha] = pin.trim().split(/\s+/);
        // /tmp/walkthrough-top ("<number>") drops the layers above one PR,
        // so a long stack can play a shorter one.
        const top = await import("node:fs/promises")
          .then((fs) => fs.readFile("/tmp/walkthrough-top", "utf8"))
          .catch(() => "");
        if (!stack) return stack;
        const topIndex = stack.codeChanges.findIndex(
          (change) => String(change.number) === top.trim(),
        );
        const kept =
          topIndex < 0
            ? stack.codeChanges
            : stack.codeChanges.slice(0, topIndex + 1);
        return {
          codeChanges: kept.map((change) =>
            sha && String(change.number) === number
              ? { ...change, headSha: sha }
              : change,
          ),
        };
      },
      readDiff: (ctx: object) => hooks.readDiff(wrap(ctx)),
      readFile: (ctx: object) => hooks.readFile(wrap(ctx)),
    },
  },
} as never;
