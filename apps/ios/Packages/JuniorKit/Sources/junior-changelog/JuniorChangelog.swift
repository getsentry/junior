import Foundation

/// The TestFlight lane's changelog step (`fastlane/Fastfile`):
///
///     swift run junior-changelog prepare <CHANGELOG.md> <history.json> <build> <base-version> <result.json>
///
/// `history.json` holds the earlier builds as `ShippedBuild`s. It rewrites
/// CHANGELOG.md for this build and writes `{"version", "notes"}` to
/// `result.json`. `base-version` is the version when TestFlight has no build.
@main
struct JuniorChangelog {
  struct Result: Encodable {
    var version: String
    var notes: String
  }

  static func main() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 6, arguments[0] == "prepare", let build = Int(arguments[3]) else {
      let usage = "usage: junior-changelog prepare <CHANGELOG.md> <history.json> <build> <base-version> <result.json>\n"
      FileHandle.standardError.write(Data(usage.utf8))
      exit(2)
    }
    let changelogURL = URL(fileURLWithPath: arguments[1])
    let shipped = try JSONDecoder().decode(
      [ShippedBuild].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[2])))
    let date = Date().formatted(Date.ISO8601FormatStyle(timeZone: .gmt).year().month().day())
    let release = try prepareRelease(
      changelog: String(contentsOf: changelogURL, encoding: .utf8), shipped: shipped, build: build,
      baseVersion: arguments[4], date: date)
    try release.changelog.write(to: changelogURL, atomically: true, encoding: .utf8)
    try JSONEncoder().encode(Result(version: release.version, notes: release.notes))
      .write(to: URL(fileURLWithPath: arguments[5]))
  }
}
