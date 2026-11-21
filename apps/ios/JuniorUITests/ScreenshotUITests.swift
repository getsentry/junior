import UIKit
import XCTest

/// Saves landscape screenshots, which `simctl` cannot take because it cannot
/// rotate a simulator. `scripts/screenshots.sh <out-dir> landscape` runs it
/// with the shots; without them it skips.
@MainActor
final class ScreenshotUITests: XCTestCase {
  func testLandscapeShots() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let dir = environment["JUNIOR_IOS_SHOTS_DIR"], let shots = environment["JUNIOR_IOS_SHOTS"] else {
      throw XCTSkip("Run through scripts/screenshots.sh")
    }
    let server = environment["JUNIOR_IOS_SERVER"] ?? "http://127.0.0.1:4317"
    XCUIDevice.shared.orientation = .landscapeLeft
    // A cold first launch shows the list still loading after the shot delay.
    let warmUp = launch(server: server, path: "/", theme: "dark")
    let row = warmUp.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Investigate checkout latency"))
    XCTAssertTrue(row.firstMatch.waitForExistence(timeout: 30))
    warmUp.terminate()
    // A shot is `name|dashboard path|theme`, separated by `;`.
    for shot in shots.split(separator: ";") {
      let parts = shot.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
      let app = launch(server: server, path: parts[1], theme: parts.count > 2 ? parts[2] : "dark")
      sleep(3)
      let file = URL(fileURLWithPath: dir).appending(path: "\(parts[0]).png")
      try png(XCUIScreen.main.screenshot().image).write(to: file)
      app.terminate()
    }
  }

  private func launch(server: String, path: String, theme: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-JuniorServer", server, "-JuniorFixedNow", "2026-08-07T12:00:00Z", "-JuniorOpen", path,
      "-JuniorTheme", theme, "-JuniorAccessToken", "mock-access-token",
    ]
    app.launch()
    return app
  }

  /// Redraw so the file is upright whatever orientation the capture has.
  private func png(_ image: UIImage) -> Data {
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
  }
}
