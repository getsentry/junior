/**
 * Best-effort detection of GitHub clones typed into the bash tool.
 *
 * `github_cloneRepository` checks for a matching Workspace before it clones.
 * A raw `git clone` or `gh repo clone` skips that check. This module reads the
 * command text with a small tokenizer, not a full shell parser. It is brittle:
 * it misses clones behind `sh -c`, `eval`, scripts, aliases, or variables.
 * It is steering for the model, not a security boundary. Egress cannot block
 * clones either, because clone and fetch use the same `git-upload-pack`
 * request.
 *
 * When the text is unclear, prefer a miss over a false denial.
 */

const CLONE_DENIAL_MESSAGE =
  "Use github_cloneRepository to clone GitHub repositories, not git clone or gh repo clone. It checks for a matching Workspace first.";

/** Git global options that take the next token as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c"]);

/**
 * Return a denial message when a bash command clones a GitHub repository
 * without `github_cloneRepository`. Return undefined for other commands.
 */
export function githubCloneCommandDenial(command: string): string | undefined {
  for (const words of splitSimpleCommands(command)) {
    if (isGitHubClone(words)) {
      return CLONE_DENIAL_MESSAGE;
    }
  }
  return undefined;
}

function isGitHubClone(words: string[]): boolean {
  let index = 0;
  while (
    index < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)
  ) {
    index += 1;
  }
  const [program, ...args] = words.slice(index);
  if (program === "gh") {
    if (args[0] !== "repo") {
      return false;
    }
    if (args[1] === "clone") {
      return true;
    }
    return (
      args[1] === "fork" &&
      args.some((arg) => arg === "--clone" || arg === "--clone=true")
    );
  }
  if (program !== "git") {
    return false;
  }
  let argIndex = 0;
  while (args[argIndex]?.startsWith("-")) {
    argIndex += GIT_OPTIONS_WITH_VALUE.has(args[argIndex]!) ? 2 : 1;
  }
  // Only GitHub remotes. Local and other-host clones stay allowed.
  return (
    args[argIndex] === "clone" &&
    args.slice(argIndex + 1).some((arg) => arg.includes("github.com"))
  );
}

/**
 * Split command text into simple commands of words. Quotes join words, and
 * shell operators end a command. Text after `<<` is skipped, because heredoc
 * bodies are data, such as docs that show `git clone`.
 */
function splitSimpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index];
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && index + 1 < command.length) {
      index += 1;
      if (command[index] !== "\n") {
        word += command[index];
        inWord = true;
      }
    } else if (char === "<" && command[index + 1] === "<") {
      break;
    } else if (/[;&|()`\n]/.test(char)) {
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
