import Foundation

/// Token roles for code blocks. The app maps them to the GitHub dark and light
/// themes that the dashboard's Shiki highlighter uses.
public enum CodeTokenKind: Equatable, Sendable {
  case plain, keyword, string, number, comment, function, type, property
}

public struct CodeToken: Equatable, Sendable {
  public var text: String
  public var kind: CodeTokenKind
}

/// Split code into colored tokens. A small lexer, not a full grammar: enough
/// for the languages Junior writes most (SQL, shell, JS/TS, Python, Swift,
/// JSON, YAML, Go, Rust).
public func highlightCode(_ code: String, language: String?) -> [CodeToken] {
  let lang = CodeLanguage(language)
  var tokens: [CodeToken] = []
  let chars = Array(code)
  var i = 0

  func append(_ text: String, _ kind: CodeTokenKind) {
    if let last = tokens.last, last.kind == kind {
      tokens[tokens.count - 1].text += text
    } else {
      tokens.append(CodeToken(text: text, kind: kind))
    }
  }

  func startsWith(_ prefix: String, at index: Int) -> Bool {
    let p = Array(prefix)
    guard index + p.count <= chars.count else { return false }
    return Array(chars[index..<index + p.count]) == p
  }

  while i < chars.count {
    let c = chars[i]
    // Comments
    if lang.lineComments.contains(where: { startsWith($0, at: i) }) {
      var j = i
      while j < chars.count, chars[j] != "\n" { j += 1 }
      append(String(chars[i..<j]), .comment)
      i = j
      continue
    }
    if lang.blockComments, startsWith("/*", at: i) {
      var j = i + 2
      while j < chars.count, !(chars[j] == "*" && j + 1 < chars.count && chars[j + 1] == "/") { j += 1 }
      j = min(chars.count, j + 2)
      append(String(chars[i..<j]), .comment)
      i = j
      continue
    }
    // Strings
    if lang.quotes.contains(c) {
      var j = i + 1
      while j < chars.count {
        if chars[j] == "\\" {
          j += 2
          continue
        }
        if chars[j] == c {
          j += 1
          break
        }
        if chars[j] == "\n", c != "`" { break }
        j += 1
      }
      j = min(chars.count, j)
      let text = String(chars[i..<j])
      // JSON object keys read as properties, as in GitHub themes.
      var k = j
      while k < chars.count, chars[k] == " " { k += 1 }
      let isKey = lang == .json && k < chars.count && chars[k] == ":"
      append(text, isKey ? .property : .string)
      i = j
      continue
    }
    // Numbers
    if c.isNumber, i == 0 || !(chars[i - 1].isLetter || chars[i - 1] == "_") {
      var j = i
      while j < chars.count,
        chars[j].isNumber || chars[j] == "." || chars[j] == "_"
          || chars[j].isLetter && "xabcdefABCDEF".contains(chars[j])
      { j += 1 }
      append(String(chars[i..<j]), .number)
      i = j
      continue
    }
    // Words
    if c.isLetter || c == "_" || (c == "$" && lang == .shell) {
      var j = i + 1
      while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" { j += 1 }
      let word = String(chars[i..<j])
      var k = j
      while k < chars.count, chars[k] == " " { k += 1 }
      let calls = k < chars.count && chars[k] == "("
      let kind: CodeTokenKind
      if lang.keywords.contains(lang.caseInsensitive ? word.uppercased() : word) {
        kind = .keyword
      } else if lang.constants.contains(word) || (lang == .shell && c == "$") {
        kind = .number
      } else if calls {
        kind = .function
      } else if lang == .yaml, k < chars.count, chars[k] == ":" {
        kind = .property
      } else if lang.capitalizedTypes, c.isUppercase {
        kind = .type
      } else {
        kind = .plain
      }
      append(word, kind)
      i = j
      continue
    }
    append(String(c), .plain)
    i += 1
  }
  return tokens
}

private enum CodeLanguage: Equatable {
  case sql, shell, javascript, python, swift, json, yaml, go, rust, other

  init(_ name: String?) {
    switch name?.lowercased() {
    case "sql", "postgres", "postgresql", "mysql", "sqlite": self = .sql
    case "sh", "bash", "zsh", "shell", "console", "shellscript": self = .shell
    case "js", "javascript", "ts", "typescript", "tsx", "jsx", "mjs", "cjs": self = .javascript
    case "py", "python": self = .python
    case "swift": self = .swift
    case "json", "jsonc", "json5": self = .json
    case "yaml", "yml", "toml": self = .yaml
    case "go", "golang": self = .go
    case "rs", "rust": self = .rust
    default: self = .other
    }
  }

  var caseInsensitive: Bool { self == .sql }
  var capitalizedTypes: Bool { [.javascript, .swift, .go, .rust].contains(self) }
  var blockComments: Bool { [.sql, .javascript, .swift, .go, .rust, .other].contains(self) }

  var lineComments: [String] {
    switch self {
    case .sql: ["--"]
    case .shell, .python, .yaml: ["#"]
    case .json: []
    case .javascript, .swift, .go, .rust, .other: ["//"]
    }
  }

  var quotes: Set<Character> {
    switch self {
    case .javascript: ["\"", "'", "`"]
    case .json, .swift, .go, .rust: ["\""]
    default: ["\"", "'"]
    }
  }

  var constants: Set<String> {
    ["true", "false", "null", "nil", "None", "True", "False", "undefined", "NULL", "TRUE", "FALSE"]
  }

  var keywords: Set<String> {
    switch self {
    case .sql:
      [
        "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "AS", "ON", "JOIN", "LEFT", "RIGHT",
        "INNER", "OUTER", "FULL", "CROSS", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "ASC",
        "DESC", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "INDEX",
        "DROP", "ALTER", "ADD", "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END",
        "WITH", "INTERVAL", "BETWEEN", "LIKE", "EXISTS", "RETURNING", "PRIMARY", "KEY", "DEFAULT",
        "OVER", "PARTITION",
      ]
    case .shell:
      [
        "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in",
        "function", "return", "export", "local", "echo", "cd", "set",
      ]
    case .javascript:
      [
        "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
        "case", "break", "continue", "new", "class", "extends", "import", "from", "export", "default",
        "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
        "type", "interface", "enum", "as", "satisfies", "this", "void", "yield", "readonly",
      ]
    case .python:
      [
        "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
        "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield",
        "async", "await", "pass", "break", "continue", "is", "global",
      ]
    case .swift:
      [
        "func", "let", "var", "struct", "class", "enum", "protocol", "extension", "return", "if",
        "else", "guard", "for", "while", "in", "switch", "case", "default", "import", "async",
        "await", "throws", "try", "self", "init", "public", "private", "static", "some", "any",
      ]
    case .go:
      [
        "func", "package", "import", "return", "if", "else", "for", "range", "var", "const", "type",
        "struct", "interface", "map", "chan", "go", "defer", "switch", "case", "default",
      ]
    case .rust:
      [
        "fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "return", "if",
        "else", "match", "for", "while", "loop", "in", "async", "await", "self", "Self", "where",
      ]
    case .json, .yaml, .other:
      []
    }
  }
}
