import JuniorKit
import SwiftUI

/// An icon drawn from SVG path data, filled with the foreground style.
struct PathIcon: View {
  let paths: [String]
  let grid: CGFloat
  var size: CGFloat = 12

  var body: some View {
    PathShape(paths: paths, grid: grid)
      .fill(style: FillStyle(eoFill: false))
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

private struct PathShape: Shape {
  let paths: [String]
  let grid: CGFloat

  func path(in rect: CGRect) -> Path {
    var path = Path()
    let scale = min(rect.width, rect.height) / grid
    let transform = CGAffineTransform(scaleX: scale, y: scale)
    for data in paths {
      path.addPath(Path(svgPath(data)), transform: transform)
    }
    return path
  }
}

extension PathIcon {
  static func octicon(_ name: String, size: CGFloat = 16) -> PathIcon {
    PathIcon(paths: IconPaths.octicons[name] ?? IconPaths.octicons["file"] ?? [], grid: 16, size: size)
  }

  static func slack(size: CGFloat = 12) -> PathIcon {
    PathIcon(paths: IconPaths.slackMark.paths, grid: IconPaths.slackMark.size, size: size)
  }

  static func github(size: CGFloat = 12) -> PathIcon {
    PathIcon(paths: IconPaths.githubMark.paths, grid: IconPaths.githubMark.size, size: size)
  }
}

/// How the dashboard draws a linked object: its Octicon and color
/// (`object-presentation.ts`).
struct ObjectPresentation {
  let icon: String
  let color: Color

  init(objectType: String?, status: String?) {
    let base = objectType == "task" ? "issue-opened" : objectType == "code_change" ? "git-pull-request" : "file"
    switch (objectType, status) {
    case ("code_change", "draft"):
      icon = "git-pull-request-draft"
      color = Tokens.textMuted
    case ("code_change", "merged"):
      icon = "git-merge"
      color = .palette(.violet, 400)
    case ("code_change", "closed"):
      icon = "git-pull-request-closed"
      color = .palette(.rose, 500)
    case ("task", "closed"), ("task", "done"):
      icon = "issue-closed"
      color = .palette(.violet, 400)
    case (_, "warning"), (_, "blocked"):
      icon = base
      color = .palette(.amber, 500)
    case ("code_change", _), ("task", _):
      icon = base
      color = .palette(.emerald, 500)
    default:
      icon = base
      color = Tokens.textMuted
    }
  }
}

/// A dashboard icon: the Lucide icon the web draws (2pt stroke on a 24pt
/// grid, scaled), or an SF Symbol for names Lucide does not have here.
struct Icon: View {
  let name: String
  var size: CGFloat = 16
  var stroke: CGFloat = 2

  init(_ name: String, size: CGFloat = 16, stroke: CGFloat = 2) {
    self.name = name
    self.size = size
    self.stroke = stroke
  }

  var body: some View {
    Group {
      if let paths = IconPaths.lucide[name] {
        LucideShape(paths: paths)
          .stroke(style: StrokeStyle(lineWidth: stroke * size / 24, lineCap: .round, lineJoin: .round))
      } else {
        Image(systemName: name).font(.system(size: size * 0.86))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct LucideShape: Shape {
  let paths: [String]

  func path(in rect: CGRect) -> Path {
    var path = Path()
    let scale = min(rect.width, rect.height) / 24
    let transform = CGAffineTransform(scaleX: scale, y: scale)
    for data in paths {
      path.addPath(Path(svgPath(data)), transform: transform)
    }
    return path
  }
}
