// swift-tools-version: 6.0
import PackageDescription

// Platform-independent Junior logic: API models, the dashboard API client,
// markdown parsing, and display rules. Its tests run on macOS with `swift test`.
let package = Package(
  name: "JuniorKit",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "JuniorKit", targets: ["JuniorKit"])],
  targets: [
    .target(name: "JuniorKit"),
    .testTarget(
      name: "JuniorKitTests",
      dependencies: ["JuniorKit"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
