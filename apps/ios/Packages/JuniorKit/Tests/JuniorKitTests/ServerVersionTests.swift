import Testing

@testable import JuniorKit

struct ServerVersionTests {
  @Test func showsTheReleaseAndShortCommit() {
    #expect(serverVersionLabel("0.314.0+4f2c9a1e0b7d") == "0.314.0 · 4f2c9a1")
  }

  @Test func showsAVersionWithNoCommitAsIs() {
    #expect(serverVersionLabel("0.314.0") == "0.314.0")
  }
}
