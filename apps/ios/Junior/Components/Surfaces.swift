import JuniorKit
import SwiftUI

extension View {
  /// A text input: `text-sm` with `py-2`, as the web input.
  func dashboardInput() -> some View {
    font(.dashboard(.sm))
      .foregroundStyle(Tokens.text)
      .padding(.horizontal, 12)
      .frame(height: 37)
      .background(Tokens.ink, in: RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderEmphasis))
  }

  /// List card: radius 8, `border-subtle`, `fill-faint`; stronger while its
  /// item is open beside the list. The 1pt inset matches CSS, where a border
  /// adds to the box.
  func listCard(radius: CGFloat = 8, selected: Bool = false) -> some View {
    padding(1)
      .background(selected ? Tokens.fillHover : Tokens.fillFaint, in: RoundedRectangle(cornerRadius: radius))
      .overlay(
        RoundedRectangle(cornerRadius: radius).strokeBorder(selected ? Tokens.borderEmphasis : Tokens.borderSubtle))
  }

  /// Cap content at the dashboard's reading width (`max-w-[52.5rem]`) and
  /// center it, so lines stay short on a wide screen.
  func readableWidth() -> some View {
    frame(maxWidth: 840).frame(maxWidth: .infinity)
  }

  /// Panel card: radius 8, `border-subtle`, `surface-panel`.
  func panelCard(radius: CGFloat = 8) -> some View {
    padding(1)
      .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: radius))
      .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Tokens.borderSubtle))
  }

  /// A 1pt hairline on one edge.
  func hairline(_ edge: VerticalEdge, _ color: Color = Tokens.border) -> some View {
    overlay(alignment: edge == .top ? .top : .bottom) {
      Rectangle().fill(color).frame(height: 1)
    }
  }
}

/// Sticky-style section heading with a disclosure chevron
/// (`ConversationSectionHeading.tsx`). The count shows only while collapsed.
struct SectionHeading: View {
  let title: String
  let count: Int
  @Binding var collapsed: Bool

  var body: some View {
    Button {
      withAnimation(.snappy(duration: 0.2)) { collapsed.toggle() }
    } label: {
      HStack(spacing: 8) {
        Icon("chevron-right", size: 12)
          .rotationEffect(.degrees(collapsed ? 0 : 90))
          .frame(width: 14)
        Text(title)
          .type(.xs, .medium)
          .foregroundStyle(Tokens.textMuted)
        if collapsed {
          Text("\(count)")
            .type(.xs)
            .monospacedDigit()
            .foregroundStyle(Tokens.textFaint)
        }
        Spacer(minLength: 0)
      }
      .foregroundStyle(Tokens.textMuted)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, -4)
    .accessibilityLabel("\(title), \(count) \(count == 1 ? "item" : "items")")
    .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    .accessibilityAddTraits(.isHeader)
  }
}

/// Compact search field (`SearchInput.tsx`): 36pt, radius 6, `border`.
struct SearchField: View {
  let placeholder: String
  @Binding var text: String

  var body: some View {
    HStack(spacing: 10) {
      Icon("search", size: 13, stroke: 2.5)
        .foregroundStyle(Tokens.textMuted)
      TextField(
        "", text: $text,
        prompt: Text(placeholder).foregroundStyle(Tokens.textMuted.opacity(0.7))
      )
      .type(.sm)
      .foregroundStyle(Tokens.text)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .submitLabel(.search)
      Button {
        text = ""
      } label: {
        Icon("x", size: 14)
          .foregroundStyle(Tokens.textMuted)
          .frame(width: 24, height: 24)
          .hitArea()
      }
      .buttonStyle(.plain)
      .opacity(text.isEmpty ? 0 : 1)
      .disabled(text.isEmpty)
      .accessibilityLabel("Clear search")
    }
    .padding(.leading, 9)
    .padding(.trailing, 6)
    .frame(height: 36)
    .background(Tokens.overlaySoft, in: RoundedRectangle(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.border))
  }
}

/// Outline tag (`ConversationContextTags`): 24pt, radius 6, `border`. It
/// hugs its content up to `maxWidth`, then truncates.
struct TagChip<Leading: View>: View {
  let label: String
  var detail: String?
  var maxWidth: CGFloat = 160
  /// Shows the outbound mark when the tag opens a link.
  var outbound = false
  @ViewBuilder var icon: Leading

  var body: some View {
    CappedWidth(width: maxWidth) {
      HStack(spacing: 4) {
        icon
        (Text(label).font(.dashboard(.xxs, .medium)).foregroundStyle(Tokens.textMuted)
          + Text(detail.map { " \($0)" } ?? "").font(.dashboard(.xxs)).foregroundStyle(Tokens.text))
          .lineLimit(1)
          .truncationMode(.tail)
        if outbound {
          Icon("external-link", size: 9.6).foregroundStyle(Tokens.textMuted).opacity(0.6)
        }
      }
      .padding(.horizontal, 6)
      .frame(minHeight: 24)
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.border))
    }
  }
}

/// Size a view to its content, but never wider than `width` (CSS max-width).
struct CappedWidth: Layout {
  let width: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let capped = min(proposal.width ?? width, width)
    return child.sizeThatFits(ProposedViewSize(width: capped, height: proposal.height))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

/// A rotating Lucide `loader-circle`; still under Reduce Motion.
struct Spinner: View {
  var size: CGFloat = 14
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turning = false

  var body: some View {
    Icon("loader-circle", size: size)
      .rotationEffect(.degrees(turning ? 360 : 0))
      .animation(reduceMotion ? nil : .linear(duration: 1).repeatForever(autoreverses: false), value: turning)
      .onAppear { turning = true }
  }
}

/// A colored status dot.
struct Dot: View {
  let color: Color
  var size: CGFloat = 6

  var body: some View {
    Circle().fill(color).frame(width: size, height: size).accessibilityHidden(true)
  }
}

/// Person avatar: the profile photo, or a violet-300 circle with initials
/// until it loads or when it fails; Junior shows its avatar.
struct Avatar: View {
  enum Kind {
    /// A person, by display name and the path of their profile photo.
    case person(String?, photo: String?)
    case agent
    case parentAgent
    /// An Event or Automation that started a Turn.
    case event
  }

  let kind: Kind
  var size: CGFloat = 24

  var body: some View {
    switch kind {
    case .agent:
      Image("JuniorAvatar")
        .resizable()
        .interpolation(.high)
        .scaledToFit()
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    case .event:
      Circle().fill(Tokens.surfaceHover).frame(width: size, height: size)
        .overlay(Icon("zap", size: 14).foregroundStyle(Color.palette(.amber, 300)))
        .accessibilityHidden(true)
    case .parentAgent:
      Circle().fill(Tokens.surfaceHover).frame(width: size, height: size)
        .overlay(Icon("bot", size: 15).foregroundStyle(Color.palette(.cyan, 200)))
        .accessibilityHidden(true)
    case .person(let name, let photo):
      Circle().fill(Color.palette(.violet, 300)).frame(width: size, height: size)
        .overlay(
          Text(Self.initials(name))
            .type(.xs, .semibold)
            .foregroundStyle(Tokens.textInverse)
            .minimumScaleFactor(0.5)
            .padding(2)
        )
        .overlay { if let photo { Photo(path: photo) } }
        .accessibilityHidden(true)
    }
  }

  /// A profile photo, which loads with the sign-in token.
  private struct Photo: View {
    @Environment(AppModel.self) private var app
    let path: String
    @State private var image: UIImage?

    // `Color.clear`, not an empty view, so `task` runs before the photo loads.
    var body: some View {
      Color.clear
        .overlay { if let image { Image(uiImage: image).resizable().scaledToFill() } }
        .clipShape(Circle())
        .task(id: path) { image = await app.photo(path) }
    }
  }

  /// Up to two initials, as the dashboard avatar shows them.
  static func initials(_ name: String?) -> String {
    let words = (name ?? "").split(whereSeparator: { " ._-@".contains($0) })
    let letters = words.prefix(2).compactMap { $0.first.map { String($0).uppercased() } }
    return letters.isEmpty ? "?" : letters.joined()
  }
}

/// A rounded placeholder block for loading regions. Shimmer stops under
/// Reduce Motion.
struct Skeleton: View {
  var width: CGFloat?
  var height: CGFloat
  var radius: CGFloat = 4
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var phase = false

  var body: some View {
    RoundedRectangle(cornerRadius: radius)
      .fill(Tokens.fillHover)
      .frame(width: width, height: height)
      .opacity(reduceMotion ? 1 : (phase ? 0.55 : 1))
      .animation(reduceMotion ? nil : .easeInOut(duration: 1).repeatForever(), value: phase)
      .onAppear { phase = true }
      .accessibilityHidden(true)
  }
}

/// Bordered message box for empty lists and load errors.
struct EmptyBox: View {
  let text: String
  var retry: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(text)
        .type(.sm)
        .foregroundStyle(Tokens.textMuted)
      if let retry {
        Button("Retry", action: retry).buttonStyle(.dashboard(.outline))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .listCard()
  }
}

/// Red one-line error, as `InlineError` renders it.
struct InlineError: View {
  let text: String

  var body: some View {
    Text(text)
      .type(.xs)
      .foregroundStyle(Color.palette(.rose, 300))
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// Underlined tab strip (`SegmentedNav` with `fill`).
struct SegmentedTabs<Tab: Hashable>: View {
  let tabs: [(Tab, String)]
  @Binding var selection: Tab

  var body: some View {
    HStack(spacing: 20) {
      ForEach(tabs, id: \.0) { tab, label in
        Button {
          selection = tab
        } label: {
          Text(label)
            .type(.sm, .medium)
            .foregroundStyle(selection == tab ? Tokens.text : Tokens.textMuted)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .overlay(alignment: .bottom) {
              if selection == tab {
                Rectangle().fill(Tokens.textSolid).frame(height: 2)
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == tab ? [.isSelected, .isButton] : .isButton)
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .hairline(.bottom)
  }
}
