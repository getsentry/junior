import SwiftUI
import UIKit

/// Dashboard design tokens, mirrored from
/// `packages/junior-dashboard/src/tailwind.css`. Views use these roles, never
/// literal colors, so both themes stay in step with the web dashboard.
enum Tokens {
  static let bg = dynamic(dark: 0x060607, light: 0xFFFFFF)
  static let bgElevated = dynamic(dark: 0x09090B, light: 0xFFFFFF)
  static let surfacePanel = dynamic(dark: 0x0C0C0E, light: 0xF9F9FA)
  static let surfaceActive = dynamic(dark: 0x1C1C20, light: 0xE9E9EC)
  static let surfaceRaised = dynamic(dark: 0x101013, light: 0xFFFFFF)
  static let surfaceHover = dynamic(dark: 0x17171A, light: 0xF1F1F3)
  static let control = dynamic(dark: 0x121215, light: 0xFFFFFF)
  static let ink = dynamic(dark: 0x000000, light: 0xFFFFFF)

  static let text = dynamic(dark: 0xF4F4F5, light: 0x18181B)
  static let textMuted = dynamic(dark: 0xA1A1AA, light: 0x52525B)
  static let textSubtle = dynamic(dark: 0xC4C4CC, light: 0x3F3F46)
  static let textFaint = dynamic(dark: 0x8A8A93, light: 0x71717A)
  static let textSolid = dynamic(dark: 0xFFFFFF, light: 0x09090B)
  static let textInverse = dynamic(dark: 0x000000, light: 0xFFFFFF)

  static let accent = dynamic(dark: 0xBEAAFF, light: 0x7553FF)
  static let accentText = dynamic(dark: 0xDDD3FF, light: 0x5B3BD9)
  static let focus = accent

  static let borderSubtle = hairline(dark: 0.06, light: 0.06)
  static let border = hairline(dark: 0.08, light: 0.09)
  static let borderStrong = hairline(dark: 0.10, light: 0.11)
  static let borderEmphasis = hairline(dark: 0.15, light: 0.16)
  static let borderInteractive = hairline(dark: 0.25, light: 0.26)
  static let borderHeavy = hairline(dark: 0.30, light: 0.32)

  static let fillFaint = hairline(dark: 0.02, light: 0.02)
  static let fillSoft = hairline(dark: 0.035, light: 0.035)
  static let fillHover = hairline(dark: 0.06, light: 0.05)
  static let fillStrong = hairline(dark: 0.10, light: 0.08)

  static let overlaySoft = dynamicRGBA(dark: (0, 0.2), light: (0, 0.06))
  static let overlay = dynamicRGBA(dark: (0, 0.55), light: (0, 0.35))

  /// Browser chrome color for each theme (`DASHBOARD_THEME_COLORS`).
  static let chrome = dynamic(dark: 0x000000, light: 0xFFFFFF)

  /// Hairlines are white on the dark canvas and black on the light one.
  private static func hairline(dark: Double, light: Double) -> Color {
    dynamicRGBA(dark: (1, dark), light: (0, light))
  }

  private static func dynamicRGBA(
    dark: (white: CGFloat, alpha: Double),
    light: (white: CGFloat, alpha: Double)
  ) -> Color {
    Color(
      uiColor: UIColor { traits in
        let value = traits.userInterfaceStyle == .light ? light : dark
        return UIColor(white: value.white, alpha: value.alpha)
      })
  }

  static func dynamic(dark: UInt32, light: UInt32) -> Color {
    Color(
      uiColor: UIColor { traits in
        UIColor(hex: traits.userInterfaceStyle == .light ? light : dark)
      })
  }
}

/// Tailwind v4 palette hues the dashboard uses for status and chart accents.
/// Light theme mirrors shades 50-400 (50 to 950, 100 to 900, …) for the hues
/// that `tailwind.css` lists, so the same role keeps its contrast.
enum Hue: CaseIterable {
  case red, orange, amber, yellow, emerald, green, teal, cyan, sky, blue, indigo, violet,
    purple, fuchsia, pink, rose, zinc

  fileprivate var shades: [Int: UInt32] {
    switch self {
    case .red:
      [50: 0xFEF2F2, 100: 0xFFE2E2, 200: 0xFFC9C9, 300: 0xFFA2A2, 400: 0xFF6467, 500: 0xFB2C36, 600: 0xE7000B, 700: 0xC10007, 800: 0x9F0712, 900: 0x82181A, 950: 0x460809]
    case .orange:
      [50: 0xFFF7ED, 100: 0xFFEDD4, 200: 0xFFD6A7, 300: 0xFFB86A, 400: 0xFF8904, 500: 0xFF6900, 600: 0xF54900, 700: 0xCA3500, 800: 0x9F2D00, 900: 0x7E2A0C, 950: 0x441306]
    case .amber:
      [50: 0xFFFBEB, 100: 0xFEF3C6, 200: 0xFEE685, 300: 0xFFD230, 400: 0xFFB900, 500: 0xFE9A00, 600: 0xE17100, 700: 0xBB4D00, 800: 0x973C00, 900: 0x7B3306, 950: 0x461901]
    case .yellow:
      [50: 0xFEFCE8, 100: 0xFEF9C2, 200: 0xFFF085, 300: 0xFFDF20, 400: 0xFDC700, 500: 0xF0B100, 600: 0xD08700, 700: 0xA65F00, 800: 0x894B00, 900: 0x733E0A, 950: 0x432004]
    case .emerald:
      [50: 0xECFDF5, 100: 0xD0FAE5, 200: 0xA4F4CF, 300: 0x5EE9B5, 400: 0x00D492, 500: 0x00BC7D, 600: 0x009966, 700: 0x007A55, 800: 0x006045, 900: 0x004F3B, 950: 0x002C22]
    case .green:
      [50: 0xF0FDF4, 100: 0xDCFCE7, 200: 0xB9F8CF, 300: 0x7BF1A8, 400: 0x05DF72, 500: 0x00C950, 600: 0x00A63E, 700: 0x008236, 800: 0x016630, 900: 0x0D542B, 950: 0x032E15]
    case .teal:
      [50: 0xF0FDFA, 100: 0xCBFBF1, 200: 0x96F7E4, 300: 0x46ECD5, 400: 0x00D5BE, 500: 0x00BBA7, 600: 0x009689, 700: 0x00786F, 800: 0x005F5A, 900: 0x0B4F4A, 950: 0x022F2E]
    case .cyan:
      [50: 0xECFEFF, 100: 0xCEFAFE, 200: 0xA2F4FD, 300: 0x53EAFD, 400: 0x00D3F2, 500: 0x00B8DB, 600: 0x0092B8, 700: 0x007595, 800: 0x005F78, 900: 0x104E64, 950: 0x053345]
    case .sky:
      [50: 0xF0F9FF, 100: 0xDFF2FE, 200: 0xB8E6FE, 300: 0x74D4FF, 400: 0x00BCFF, 500: 0x00A6F4, 600: 0x0084D1, 700: 0x0069A8, 800: 0x00598A, 900: 0x024A70, 950: 0x052F4A]
    case .blue:
      [50: 0xEFF6FF, 100: 0xDBEAFE, 200: 0xBEDBFF, 300: 0x8EC5FF, 400: 0x51A2FF, 500: 0x2B7FFF, 600: 0x155DFC, 700: 0x1447E6, 800: 0x193CB8, 900: 0x1C398E, 950: 0x162456]
    case .indigo:
      [50: 0xEEF2FF, 100: 0xE0E7FF, 200: 0xC6D2FF, 300: 0xA3B3FF, 400: 0x7C86FF, 500: 0x615FFF, 600: 0x4F39F6, 700: 0x432DD7, 800: 0x372AAC, 900: 0x312C85, 950: 0x1E1A4D]
    case .violet:
      [50: 0xF5F3FF, 100: 0xEDE9FE, 200: 0xDDD6FF, 300: 0xC4B4FF, 400: 0xA684FF, 500: 0x8E51FF, 600: 0x7F22FE, 700: 0x7008E7, 800: 0x5D0EC0, 900: 0x4D179A, 950: 0x2F0D68]
    case .purple:
      [50: 0xFAF5FF, 100: 0xF3E8FF, 200: 0xE9D4FF, 300: 0xDAB2FF, 400: 0xC27AFF, 500: 0xAD46FF, 600: 0x9810FA, 700: 0x8200DB, 800: 0x6E11B0, 900: 0x59168B, 950: 0x3C0366]
    case .fuchsia:
      [50: 0xFDF4FF, 100: 0xFAE8FF, 200: 0xF6CFFF, 300: 0xF4A8FF, 400: 0xED6AFF, 500: 0xE12AFB, 600: 0xC800DE, 700: 0xA800B7, 800: 0x8A0194, 900: 0x721378, 950: 0x4B004F]
    case .pink:
      [50: 0xFDF2F8, 100: 0xFCE7F3, 200: 0xFCCEE8, 300: 0xFDA5D5, 400: 0xFB64B6, 500: 0xF6339A, 600: 0xE60076, 700: 0xC6005C, 800: 0xA3004C, 900: 0x861043, 950: 0x510424]
    case .rose:
      [50: 0xFFF1F2, 100: 0xFFE4E6, 200: 0xFFCCD3, 300: 0xFFA1AD, 400: 0xFF637E, 500: 0xFF2056, 600: 0xEC003F, 700: 0xC70036, 800: 0xA50036, 900: 0x8B0836, 950: 0x4D0218]
    case .zinc:
      [50: 0xFAFAFA, 100: 0xF4F4F5, 200: 0xE4E4E7, 300: 0xD4D4D8, 400: 0x9F9FA9, 500: 0x71717B, 600: 0x52525C, 700: 0x3F3F46, 800: 0x27272A, 900: 0x18181B, 950: 0x09090B]
    }
  }

  /// Hues whose light shades `tailwind.css` mirrors for the light theme.
  fileprivate var mirrorsInLight: Bool {
    switch self {
    case .amber, .cyan, .emerald, .fuchsia, .orange, .red, .rose, .sky, .violet: true
    default: false
    }
  }
}

extension Color {
  /// A Tailwind palette color with the dashboard's light-theme mirror applied.
  static func palette(_ hue: Hue, _ shade: Int) -> Color {
    let dark = hue.shades[shade] ?? 0xFF00FF
    let mirror = [50: 950, 100: 900, 200: 800, 300: 700, 400: 600]
    let light =
      hue.mirrorsInLight ? hue.shades[mirror[shade] ?? shade] ?? dark : dark
    return Tokens.dynamic(dark: dark, light: light)
  }
}

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha)
  }
}
