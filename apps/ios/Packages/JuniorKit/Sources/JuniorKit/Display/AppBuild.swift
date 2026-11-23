import Foundation

/// This build of the app, from the Info.plist keys that `project.yml` sets.
/// TestFlight builds get the channel and the commit from `fastlane/Fastfile`.
/// Local builds have neither.
public struct AppBuild: Equatable, Sendable {
  public let version: String
  public let build: String
  /// `beta`, or `rc` for a build of a release tag; `nil` for a local build.
  public let channel: String?
  /// The short git commit.
  public let commit: String?

  public init(info: [String: Any]) {
    func value(_ key: String) -> String? { (info[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    version = value("CFBundleShortVersionString") ?? "?"
    build = value("CFBundleVersion") ?? "?"
    channel = value("JuniorChannel")
    commit = value("JuniorCommit")
  }

  /// The build of the running app.
  public static var current: AppBuild { AppBuild(info: Bundle.main.infoDictionary ?? [:]) }

  /// `0.313.0 beta 42 · abc1234`, `0.313.0 RC · abc1234`, or `0.1.0 dev` for a
  /// local build.
  public var label: String {
    let kind =
      switch channel {
      case "beta": "beta \(build)"
      case "rc": "RC"
      default: channel ?? "dev"
      }
    return ["\(version) \(kind)", commit].compactMap { $0 }.joined(separator: " · ")
  }

  /// The version that What's New compares. It has the commit, so a beta of
  /// the same version still shows its Upcoming entries once.
  public var changelogVersion: String { commit.map { "\(version)+\($0)" } ?? version }
}
