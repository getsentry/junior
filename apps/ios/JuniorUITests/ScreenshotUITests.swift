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
    // A shot is `name|dashboard path|theme`, separated by `;`.
    for shot in shots.split(separator: ";") {
      let parts = shot.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
      let app = XCUIApplication()
      app.launchArguments = [
        "-JuniorServer", server, "-JuniorFixedNow", "2026-08-07T12:00:00Z", "-JuniorOpen", parts[1],
        "-JuniorTheme", parts.count > 2 ? parts[2] : "dark", "-JuniorAccessToken", "mock-access-token",
      ]
      app.launch()
      sleep(3)
      let file = URL(fileURLWithPath: dir).appending(path: "\(parts[0]).png")
      try png(XCUIScreen.main.screenshot().image).write(to: file)
      app.terminate()
    }
  }

  /// Redraw so the file is upright whatever orientation the capture has.
  private func png(_ image: UIImage) -> Data {
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
  }
}
