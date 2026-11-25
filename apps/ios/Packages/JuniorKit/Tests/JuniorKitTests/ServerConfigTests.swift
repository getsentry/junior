import Foundation
import Testing

@testable import JuniorKit

struct ServerConfigTests {
  private func label(_ json: String) throws -> String {
    try JSONDecoder.junior.decode(ServerConfig.self, from: Data(json.utf8)).versionLabel
  }

  @Test func showsTheReleaseAndShortCommit() throws {
    #expect(try label(#"{"basePath":"/","commit":"4f2c9a1e0b7d","version":"0.314.0"}"#) == "0.314.0 · 4f2c9a1")
  }

  @Test func showsAReleaseWithNoCommitAsIs() throws {
    #expect(try label(#"{"basePath":"/","version":"0.314.0"}"#) == "0.314.0")
  }
}
