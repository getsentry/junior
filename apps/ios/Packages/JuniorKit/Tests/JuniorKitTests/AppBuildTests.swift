import Testing

@testable import JuniorKit

@Suite struct AppBuildTests {
  private func build(_ channel: String?, commit: String?) -> AppBuild {
    var info: [String: Any] = ["CFBundleShortVersionString": "0.313.0", "CFBundleVersion": "42"]
    info["JuniorChannel"] = channel
    info["JuniorCommit"] = commit
    return AppBuild(info: info)
  }

  @Test func labelsEachKindOfBuild() {
    #expect(build("beta", commit: "abc1234").label == "0.313.0 beta 42 · abc1234")
    #expect(build("rc", commit: "abc1234").label == "0.313.0 RC · abc1234")
    #expect(build(nil, commit: "abc1234").label == "0.313.0 dev · abc1234")
    // Xcode writes an empty string for a build setting that nobody set.
    #expect(build("", commit: "").label == "0.313.0 dev")
  }

  @Test func whatsNewComparesTheCommitToo() {
    #expect(build("beta", commit: "abc1234").changelogVersion == "0.313.0+abc1234")
    #expect(build(nil, commit: nil).changelogVersion == "0.313.0")
  }
}
