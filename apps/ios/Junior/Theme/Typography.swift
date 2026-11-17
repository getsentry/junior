import SwiftUI
import UIKit

/// The dashboard type scale (`--text-2xs` … `--text-4xl`) with its line
/// heights. Sizes scale with Dynamic Type from these defaults.
enum TextStep {
  case xxs, xs, sm, base, lg, xl, xxl, xxxl, xxxxl

  var size: CGFloat {
    switch self {
    case .xxs: 12
    case .xs: 13
    case .sm: 14
    case .base: 16
    case .lg: 18
    case .xl: 20
    case .xxl: 24
    case .xxxl: 30
    case .xxxxl: 36
    }
  }

  var lineHeight: CGFloat {
    switch self {
    case .xxs, .xs: 1.15
    case .sm: 1.35
    case .base: 1.5
    case .lg: 1.35
    case .xl: 1.3
    case .xxl: 1.25
    case .xxxl: 1.2
    case .xxxxl: 1.15
    }
  }

  fileprivate var textStyle: UIFont.TextStyle {
    switch self {
    case .xxs: .caption2
    case .xs: .caption1
    case .sm: .footnote
    case .base: .body
    case .lg: .title3
    case .xl: .title3
    case .xxl: .title2
    case .xxxl: .title1
    case .xxxxl: .largeTitle
    }
  }
}

/// Font families: Inter for UI text, Outfit for display titles, and the
/// system monospace for machine values (code, ids, paths).
enum Family {
  case sans, display, mono
}

enum Typography {
  /// Inter's and Outfit's default line box, used to turn CSS line heights into
  /// SwiftUI line spacing.
  static func naturalLineHeight(_ family: Family) -> CGFloat {
    switch family {
    case .sans: 1.21
    case .display: 1.26
    case .mono: 1.19
    }
  }

  static func uiFont(_ family: Family, _ step: TextStep, weight: UIFont.Weight) -> UIFont {
    let base = rawFont(family, size: step.size, weight: weight)
    return UIFontMetrics(forTextStyle: step.textStyle).scaledFont(for: base)
  }

  static func rawFont(_ family: Family, size: CGFloat, weight: UIFont.Weight) -> UIFont {
    switch family {
    case .mono:
      return UIFont.monospacedSystemFont(ofSize: size, weight: weight)
    case .sans, .display:
      let name = family == .sans ? "Inter-Regular" : "Outfit-Thin"
      let wght = cssWeight(weight)
      let descriptor = UIFontDescriptor(fontAttributes: [
        .name: name,
        kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [
          // OpenType 'wght' axis tag.
          0x7767_6874: wght
        ],
      ])
      return UIFont(descriptor: descriptor, size: size)
    }
  }

  private static func cssWeight(_ weight: UIFont.Weight) -> CGFloat {
    switch weight {
    case .ultraLight: 200
    case .thin: 100
    case .light: 300
    case .medium: 500
    case .semibold: 600
    case .bold: 700
    case .heavy: 800
    case .black: 900
    default: 400
    }
  }
}

private struct TypeStyle: ViewModifier {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  let family: Family
  let step: TextStep
  let weight: UIFont.Weight
  let lineHeight: CGFloat?

  func body(content: Content) -> some View {
    let font = Typography.uiFont(family, step, weight: weight)
    let target = font.pointSize * (lineHeight ?? step.lineHeight)
    let natural = font.pointSize * Typography.naturalLineHeight(family)
    // Half the leading goes above the first line and below the last, as in
    // CSS. A line height under the font's own (`leading-none`) pulls the box
    // in; line spacing cannot go below zero.
    let extra = target - natural
    return
      content
      .font(Font(font))
      .lineSpacing(max(0, extra))
      .padding(.vertical, extra / 2)
  }
}

extension View {
  /// Apply one step of the dashboard type scale, with its CSS line height.
  /// `lineHeight` overrides the step's ratio, like `leading-none` (1) or
  /// `leading-relaxed` (1.625).
  func type(
    _ step: TextStep,
    _ weight: UIFont.Weight = .regular,
    family: Family = .sans,
    lineHeight: CGFloat? = nil
  ) -> some View {
    modifier(TypeStyle(family: family, step: step, weight: weight, lineHeight: lineHeight))
  }
}

extension Font {
  /// A dashboard font without line-height handling, for inline runs.
  static func dashboard(_ step: TextStep, _ weight: UIFont.Weight = .regular, family: Family = .sans) -> Font {
    Font(Typography.uiFont(family, step, weight: weight))
  }
}
