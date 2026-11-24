import SwiftUI

/// Where a screen sits when the place's list and the open item show side by
/// side (regular width, such as an iPad). `nil` in the one-stack layout and
/// on screens pushed over the open item.
enum SplitColumn {
  case list
  /// The open item, `AppModel.path.first`. It has nothing to go back to.
  case detailRoot
}

extension EnvironmentValues {
  @Entry var splitColumn: SplitColumn? = nil
}

/// The narrowest window that shows the split: the 360pt list and its 1pt
/// divider beside an open item at least 400pt wide.
let splitMinWidth: CGFloat = 761

/// The dashboard's wide layout (`ConversationWorkspace.tsx`): the place's
/// list beside the open item. Opening an item from the list replaces the
/// open item; links inside it push over it in its own stack.
struct SplitShell<Content: View>: View {
  @Environment(WindowModel.self) private var window
  @ViewBuilder var list: Content

  var body: some View {
    HStack(spacing: 0) {
      list
        .environment(\.splitColumn, .list)
        .frame(width: 360)
      Rectangle().fill(Tokens.border).frame(width: 1).ignoresSafeArea()
      NavigationStack(path: pushed) {
        openItem
          .navigationDestination(for: Route.self) { RouteScreen(route: $0) }
      }
      .frame(maxWidth: .infinity)
    }
  }

  /// Screens pushed over the open item: the rest of `window.path`.
  private var pushed: Binding<[Route]> {
    Binding(
      get: { Array(window.path.dropFirst()) },
      set: { window.path = Array(window.path.prefix(1)) + $0 })
  }

  @ViewBuilder private var openItem: some View {
    if let route = window.path.first {
      // A new identity per item, so each screen loads its own item.
      RouteScreen(route: route, column: .detailRoot).id(route)
    } else if window.place == .conversations {
      NewConversationPane()
    } else {
      Tokens.bg.ignoresSafeArea().toolbar(.hidden, for: .navigationBar)
    }
  }
}

/// Conversations with none open: start one, as the dashboard's wide home
/// does.
private struct NewConversationPane: View {
  var body: some View {
    VStack(spacing: 12) {
      Text("What do you need?")
        .type(.xxxl, .medium, family: .display)
        .foregroundStyle(Tokens.text)
        .accessibilityAddTraits(.isHeader)
      NewConversationComposer(docked: false)
    }
    .frame(maxWidth: 768)
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
  }
}
