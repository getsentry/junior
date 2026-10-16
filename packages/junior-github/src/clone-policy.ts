/**
 * Bash clone policy for GitHub repositories.
 *
 * `github_cloneRepository` checks for a matching Workspace before it clones.
 * A raw `git clone` or `gh repo clone` in bash skips that check, so the
 * `beforeToolExecute` hook denies those commands. Egress policy cannot do this:
 * clone, fetch, pull, and ls-remote all use the same git-upload-pack requests.
 *
 * This is a guardrail for normal agent commands, not a security boundary. It
 * reads plain shell syntax and `bash -c` scripts. It does not expand variables,
 * aliases, or `eval`.
 */

export const GITHUB_BASH_CLONE_DENIAL =
  "Clone GitHub repositories with the github_cloneRepository tool, not `git clone` or `gh repo clone` in bash. The tool checks for a matching Workspace first. If it names a Workspace, call switchWorkspace. For more history after the clone, run `git -C DIR fetch --deepen=N origin`.";

const SHELLS = new Set(["bash", "dash", "sh", "zsh"]);
const COMMAND_PREFIXES = new Set([
  "!",
  "{",
  "command",
  "do",
  "else",
  "env",
  "exec",
  "if",
  "nice",
  "nohup",
  "sudo",
  "then",
  "time",
  "timeout",
  "until",
  "while",
  "xargs",
]);
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);
const SEGMENT_BREAKS = new Set([";", "&", "|", "(", ")", "`", "\n"]);

/** Split a shell command into simple commands of unquoted words. */
function shellCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && index + 1 < script.length) {
        index += 1;
        word += script[index];
      } else word += char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      // A backslash before a newline continues the same command.
      if (index < script.length && script[index] !== "\n") {
        word += script[index];
        inWord = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "#" && !inWord) {
      while (index + 1 < script.length && script[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (SEGMENT_BREAKS.has(char)) {
      endCommand();
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endCommand();
  return commands;
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function isGitHubRemote(word: string): boolean {
  return /(?:^|[/@.])github\.com[:/]/i.test(word);
}

function isGitHubCloneCommand(words: string[], depth: number): boolean {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    const prefix = programName(word);
    if (!COMMAND_PREFIXES.has(prefix)) break;
    index += 1;
    while (words[index]?.startsWith("-")) index += 1;
    if (prefix === "timeout") index += 1;
  }

  const program = programName(words[index] ?? "");
  const args = words.slice(index + 1);
  if (SHELLS.has(program)) {
    const scriptIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
    return script !== undefined && hasGitHubClone(script, depth + 1);
  }
  if (program === "gh") {
    return args[0] === "repo" && args[1] === "clone";
  }
  if (program !== "git") return false;

  let argIndex = 0;
  while (args[argIndex]?.startsWith("-")) {
    argIndex += GIT_OPTIONS_WITH_VALUE.has(args[argIndex]!) ? 2 : 1;
  }
  return (
    args[argIndex] === "clone" && args.slice(argIndex + 1).some(isGitHubRemote)
  );
}

function hasGitHubClone(script: string, depth: number): boolean {
  if (depth > 3) return false;
  return shellCommands(script).some((words) =>
    isGitHubCloneCommand(words, depth),
  );
}

/** Return the denial message when a bash command clones a GitHub repository. */
export function githubBashCloneDenial(command: string): string | undefined {
  return hasGitHubClone(command, 0) ? GITHUB_BASH_CLONE_DENIAL : undefined;
}
