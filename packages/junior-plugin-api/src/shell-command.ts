/**
 * Split bash command text into simple commands.
 *
 * Plugins use this in `beforeToolExecute` to check `bash` tool input. It is a
 * small parser, not a full shell. It reads quotes, backslashes, control
 * operators, comments, redirections, and heredocs. It does not expand
 * variables, aliases, or globs. It does not look inside `sh -c` or `eval`
 * strings. Use it for best-effort steering only, not as a security boundary.
 *
 * Each result is the argv of one simple command. Leading `NAME=value`
 * assignments, redirections, and heredoc bodies are removed. Text inside
 * `$(...)`, backticks, and subshells becomes separate commands.
 */
export function parseShellCommands(text: string): string[][] {
  const commands: string[][] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let skipNextWord = false;

  const endWord = () => {
    if (inWord) {
      if (!skipNextWord) {
        words.push(word);
      }
      skipNextWord = false;
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    skipNextWord = false;
    let start = 0;
    while (start < words.length && ASSIGNMENT_RE.test(words[start]!)) {
      start += 1;
    }
    if (start < words.length) {
      commands.push(words.slice(start));
    }
    words = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const close = end === -1 ? text.length : end;
      word += text.slice(index + 1, close);
      inWord = true;
      index = close;
    } else if (char === '"') {
      inWord = true;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (
          text[index] === "\\" &&
          DOUBLE_QUOTE_ESCAPES.has(text[index + 1]!)
        ) {
          index += 1;
        }
        word += text[index];
      }
    } else if (char === "\\") {
      index += 1;
      if (index < text.length && text[index] !== "\n") {
        word += text[index];
        inWord = true;
      }
    } else if (char === "#" && !inWord) {
      const end = text.indexOf("\n", index);
      index = (end === -1 ? text.length : end) - 1;
    } else if (char === "\n") {
      endCommand();
      for (const heredoc of heredocs.splice(0)) {
        index = skipHeredocBody(text, index, heredoc);
      }
    } else if (char === "<" || char === ">") {
      // A leading fd number, such as `2` in `2>&1`, belongs to the redirection.
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      if (text.startsWith("<<<", index)) {
        index += 2;
        skipNextWord = true;
      } else if (text.startsWith("<<", index)) {
        index += 2;
        const stripTabs = text[index] === "-";
        if (stripTabs) {
          index += 1;
        }
        while (text[index] === " " || text[index] === "\t") {
          index += 1;
        }
        let delimiter = "";
        while (index < text.length && !/[\s;&|()<>]/.test(text[index]!)) {
          if (!/['"\\]/.test(text[index]!)) {
            delimiter += text[index];
          }
          index += 1;
        }
        index -= 1;
        heredocs.push({ delimiter, stripTabs });
      } else {
        while (/[<>&|]/.test(text[index + 1] ?? "")) {
          index += 1;
        }
        skipNextWord = true;
      }
    } else if (/[;&|()`]/.test(char)) {
      // Drop the `$` of `$(`, so `echo $(date)` gives `echo` and `date`.
      if (char === "(" && word.endsWith("$")) {
        word = word.slice(0, -1);
        inWord = word.length > 0;
      }
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

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

/** Return the index of the newline that ends the heredoc delimiter line. */
function skipHeredocBody(
  text: string,
  newlineIndex: number,
  heredoc: { delimiter: string; stripTabs: boolean },
): number {
  let index = newlineIndex;
  while (index < text.length) {
    const start = index + 1;
    const found = text.indexOf("\n", start);
    const end = found === -1 ? text.length : found;
    const line = text.slice(start, end);
    index = end;
    if (
      (heredoc.stripTabs ? line.replace(/^\t+/, "") : line) ===
      heredoc.delimiter
    ) {
      break;
    }
  }
  return index;
}
