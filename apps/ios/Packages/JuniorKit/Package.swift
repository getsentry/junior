// swift-tools-version: 6.0
import PackageDescription

// Platform-independent Junior logic: the MCP client and OAuth, tool models,
// markdown parsing, display rules, and the built-in demo. Its tests run on
// macOS with `swift test`.
let package = Package(
  name: "JuniorKit",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "JuniorKit", targets: ["JuniorKit"])],
  targets: [
    .target(name: "JuniorKit", resources: [.copy("Demo/demo-data.json")]),
    // The TestFlight lane writes the beta notes and the bundled changelog with it.
    .executableTarget(name: "junior-changelog", dependencies: ["JuniorKit"]),
    .testTarget(
      name: "JuniorKitTests", dependencies: ["JuniorKit", "junior-changelog"], resources: [.copy("Fixtures")]),
  ]
)
