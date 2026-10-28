import { describe, expect, it } from "vitest";
import { parseShellCommands } from "@sentry/junior-plugin-api";

describe("parseShellCommands", () => {
  it.each([
    [
      "cd /tmp && GIT_TERMINAL_PROMPT=0 git clone x; ls | wc -l",
      [["cd", "/tmp"], ["git", "clone", "x"], ["ls"], ["wc", "-l"]],
    ],
    [
      `git commit -m 'a; git clone x' -m "say \\"hi\\" \${HOME}"`,
      [["git", "commit", "-m", "a; git clone x", "-m", 'say "hi" ${HOME}']],
    ],
    [
      "echo one\\\n two\ngh pr view",
      [
        ["echo", "one", "two"],
        ["gh", "pr", "view"],
      ],
    ],
    ["ls # git clone x\npwd", [["ls"], ["pwd"]]],
    [
      "make 2>&1 > out.log < in.txt && cat <<< 'git clone x'",
      [["make"], ["cat"]],
    ],
    [
      "cat > README.md <<'EOF'\ngit clone x\nEOF\ngit status",
      [["cat"], ["git", "status"]],
    ],
    ["cat <<-END\n\tgit clone x\n\tEND\npwd", [["cat"], ["pwd"]]],
    [
      "echo $(git rev-parse HEAD) `date`",
      [["echo"], ["git", "rev-parse", "HEAD"], ["date"]],
    ],
  ])("splits %j", (text, expected) => {
    expect(parseShellCommands(text)).toEqual(expected);
  });
});
