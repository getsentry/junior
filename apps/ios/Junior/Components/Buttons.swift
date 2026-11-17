import SwiftUI

/// Dashboard button variants (`components/ui/button.tsx`): 36pt tall,
/// radius 6, 14pt medium.
struct DashboardButtonStyle: ButtonStyle {
  enum Variant {
    case primary, outline, ghost, destructive
    /// 36 by 36 square for an icon.
    case icon
    case ghostIcon
    /// Destructive icon button; the web drops its border (`border-0`).
    case destructiveIcon
  }

  let variant: Variant
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    let pressed = configuration.isPressed
    return configuration.label
      .font(.dashboard(.sm, .medium))
      .lineLimit(1)
      .foregroundStyle(foreground)
      .padding(.horizontal, isSquare ? 0 : 12)
      .frame(minWidth: isSquare ? 36 : nil, minHeight: 36)
      .frame(width: isSquare ? 36 : nil)
      .background(background(pressed: pressed), in: RoundedRectangle(cornerRadius: 6))
      .overlay {
        if let border {
          RoundedRectangle(cornerRadius: 6).strokeBorder(border)
        }
      }
      .opacity(isEnabled ? 1 : 0.5)
      .contentShape(RoundedRectangle(cornerRadius: 6))
  }

  private var isSquare: Bool { variant == .icon || variant == .ghostIcon || variant == .destructiveIcon }

  private var foreground: Color {
    switch variant {
    case .primary: Tokens.textInverse
    case .outline, .icon: Tokens.text
    case .ghost, .ghostIcon, .destructive, .destructiveIcon: Tokens.textMuted
    }
  }

  private func background(pressed: Bool) -> Color {
    switch variant {
    case .primary: pressed ? Tokens.textSolid.opacity(0.85) : Tokens.textSolid
    case .outline, .icon: pressed ? Tokens.surfaceHover : Tokens.surfaceRaised
    case .ghost, .ghostIcon, .destructive, .destructiveIcon: pressed ? Tokens.fillHover : .clear
    }
  }

  private var border: Color? {
    switch variant {
    case .outline, .icon: Tokens.borderEmphasis
    case .destructive: Tokens.borderStrong
    case .primary, .ghost, .ghostIcon, .destructiveIcon: nil
    }
  }
}

extension ButtonStyle where Self == DashboardButtonStyle {
  static func dashboard(_ variant: DashboardButtonStyle.Variant) -> DashboardButtonStyle {
    DashboardButtonStyle(variant: variant)
  }
}

/// Plain press feedback: a fill behind the label, as dashboard rows do.
struct PressableStyle: ButtonStyle {
  var radius: CGFloat = 8
  var pressedFill: Color = Tokens.fillHover
  var scale: CGFloat = 1

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        configuration.isPressed ? pressedFill : .clear, in: RoundedRectangle(cornerRadius: radius)
      )
      .scaleEffect(configuration.isPressed ? scale : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
