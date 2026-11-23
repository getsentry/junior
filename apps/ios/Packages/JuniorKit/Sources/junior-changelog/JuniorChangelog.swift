import Foundation

/// The TestFlight lane's changelog step (`fastlane/Fastfile`), run in a git
/// checkout with its history and tags:
///
///     swift run junior-changelog beta <CHANGELOG.md> <previous-notes.txt> <result.json>
///
/// `previous-notes.txt` holds the newest TestFlight build's "What to Test"
/// notes. It adds this beta's iOS entries to CHANGELOG.md as an Upcoming
/// section, and writes `{"version", "channel", "commit", "notes"}` to
/// `result.json`.
@main
struct JuniorChangelog {
  struct Result: Encodable {
    var version: String
    var channel: String
    var commit: String
    var notes: String
  }

  static func main() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 4, arguments[0] == "beta" else {
      let usage = "usage: junior-changelog beta <CHANGELOG.md> <previous-notes.txt> <result.json>\n"
      FileHandle.standardError.write(Data(usage.utf8))
      exit(2)
    }
    let tags = try git("tag", "--merged", "HEAD").split(separator: "\n").map(String.init)
    guard let release = latestRelease(tags: tags) else {
      fail("HEAD has no X.Y.Z release tag. Check out the history with its tags.")
    }
    let head = try git("rev-parse", "--short", "HEAD")
    let channel = try git("rev-parse", "HEAD") == git("rev-parse", "\(release)^{commit}") ? "rc" : "beta"
    // The previous beta's commit, unless the release tag is newer or git
    // does not know it.
    let previous = betaCommit(notes: try String(contentsOfFile: arguments[2], encoding: .utf8))
    let start = previous.flatMap { (try? git("merge-base", "--is-ancestor", release, $0)) != nil ? $0 : nil } ?? release
    let commits = try git("log", "--format=%s", "\(start)..HEAD").split(separator: "\n").compactMap {
      IOSCommit(subject: String($0))
    }

    let changelogURL = URL(fileURLWithPath: arguments[1])
    try changelog(String(contentsOf: changelogURL, encoding: .utf8), upcoming: commits)
      .write(to: changelogURL, atomically: true, encoding: .utf8)
    let notes = betaNotes(commits: commits, commit: head)
    try JSONEncoder().encode(Result(version: release, channel: channel, commit: head, notes: notes))
      .write(to: URL(fileURLWithPath: arguments[3]))
  }

  /// Run git and return its output, trimmed. Throws when git fails.
  static func git(_ arguments: String...) throws -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + arguments
    process.standardOutput = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw GitError(arguments: arguments, status: process.terminationStatus)
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("junior-changelog: \(message)\n".utf8))
    exit(1)
  }
}

struct GitError: Error {
  let arguments: [String]
  let status: Int32
}
