import SwiftUI

/// The mobile dashboard header (`DashboardHeader.tsx`): 40 | fill | 40 grid,
/// 56pt tall, translucent canvas, `border-strong` hairline.
struct AppHeader<Trailing: View, Below: View>: View {
  enum Leading {
    case menu
    case back
  }

  @Environment(WindowModel.self) private var window
  @Environment(\.splitColumn) private var column
  @Environment(\.verticalBarEdge) private var verticalBarEdge
  var title: String
  var leading: Leading = .menu
  /// Outfit 14 medium (Conversation titles) instead of Inter 14 semibold.
  var displayTitle = false
  var titleAlignment: Alignment = .center
  var trailing: Trailing
  var below: Below

  init(
    title: String, leading: Leading = .menu, displayTitle: Bool = false,
    titleAlignment: Alignment = .center, @ViewBuilder trailing: () -> Trailing,
    @ViewBuilder below: () -> Below
  ) {
    self.title = title
    self.leading = leading
    self.displayTitle = displayTitle
    self.titleAlignment = titleAlignment
    self.trailing = trailing()
    self.below = below()
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        if column == .detailRoot {
          // The open item beside the list has nothing to go back to, and the
          // list's header has the menu. The slot keeps titles aligned.
          Color.clear.frame(width: 40, height: 40)
        } else if leading == .back && verticalBarEdge != nil {
          // The system Back shows at the top of the vertical bar instead.
        } else {
          Button {
            switch leading {
            case .menu: withAnimation(.snappy(duration: 0.25)) { window.drawerOpen = true }
            // Pops the window's path: `dismiss()` here leaves the Conversation open.
            case .back: if !window.path.isEmpty { window.path.removeLast() }
            }
          } label: {
            Icon(leading == .menu ? "menu" : "arrow-left", size: 20)
              .foregroundStyle(Tokens.text)
              .frame(width: 40, height: 40)
              .contentShape(Rectangle())
          }
          .buttonStyle(PressableStyle())
          .accessibilityLabel(leading == .menu ? "Open navigation" : "Back")
        }

        Text(title)
          .font(displayTitle ? .dashboard(.sm, .medium, family: .display) : .dashboard(.sm, .semibold))
          .foregroundStyle(Tokens.text)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: titleAlignment)
          .accessibilityAddTraits(.isHeader)
          // A menu header's title is the agent name, which the list's header shows.
          .opacity(repeatsListTitle ? 0 : 1)
          .accessibilityHidden(repeatsListTitle)

        trailing
          .frame(width: 40, height: 40)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      // Above `below`, so its buttons keep their taps where the tags tuck under.
      .zIndex(1)
      below
    }
    .background(Tokens.bg.opacity(0.95))
    .hairline(.bottom, Tokens.borderStrong)
  }

  private var repeatsListTitle: Bool { column == .detailRoot && leading == .menu }
}

extension EnvironmentValues {
  /// The side where the system places bars, as on iPhone Duo closed or open
  /// in landscape. A pushed screen then shows the navigation bar for its Back.
  var verticalBarEdge: HorizontalEdge? {
    guard #available(iOS 27.1, *) else { return nil }
    return toolbarVerticalEdge
  }
}

extension AppHeader where Trailing == Color, Below == EmptyView {
  init(title: String, leading: Leading = .menu) {
    self.init(title: title, leading: leading, trailing: { Color.clear }, below: { EmptyView() })
  }
}

extension AppHeader where Below == EmptyView {
  init(
    title: String, leading: Leading = .menu, displayTitle: Bool = false,
    @ViewBuilder trailing: () -> Trailing
  ) {
    self.init(
      title: title, leading: leading, displayTitle: displayTitle, trailing: trailing, below: { EmptyView() })
  }
}
