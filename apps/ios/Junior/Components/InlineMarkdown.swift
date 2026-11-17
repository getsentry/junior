import JuniorKit
import SwiftUI

/// Inline Markdown styled like `display-text/markdown.tsx`: strong is
/// semibold in `text`, strikethrough is muted, code is mono on `fill-strong`,
/// links are medium `accent-text`.
func styledInline(
  _ source: String, step: TextStep, color: Color, family: Family = .sans, singleLine: Bool = false
) -> AttributedString {
  let text = singleLine ? source.replacingOccurrences(of: "\n", with: " ") : source
  var output = parseInlineMarkdown(text)
  let base = Typography.uiFont(family, step, weight: .regular)
  for run in output.runs {
    let intent = run.inlinePresentationIntent ?? []
    var font = base
    var foreground = color
    if intent.contains(.stronglyEmphasized) {
      font = Typography.uiFont(family, step, weight: .semibold)
      foreground = Tokens.text
    }
    if intent.contains(.emphasized) {
      font = UIFont(
        descriptor: font.fontDescriptor.withSymbolicTraits(.traitItalic) ?? font.fontDescriptor, size: font.pointSize)
    }
    if intent.contains(.code) {
      font = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular)
      output[run.range].backgroundColor = Tokens.fillStrong
    }
    if intent.contains(.strikethrough) {
      foreground = Tokens.textMuted
      output[run.range].strikethroughStyle = Text.LineStyle.single
    }
    if run.link != nil {
      font = Typography.uiFont(family, step, weight: .medium)
      foreground = Tokens.accentText
      output[run.range].underlineStyle = Text.LineStyle(pattern: .solid, color: Tokens.accent.opacity(0.35))
    }
    output[run.range].font = Font(font)
    output[run.range].foregroundColor = foreground
  }
  return padCodeRuns(output)
}

/// Pad inline code with thin spaces inside its tint, like `px-1` on the web.
private func padCodeRuns(_ text: AttributedString) -> AttributedString {
  var output = AttributedString()
  for run in text.runs {
    var piece = AttributedString(text[run.range])
    if run.inlinePresentationIntent?.contains(.code) == true {
      var pad = AttributedString("\u{2009}")
      pad.mergeAttributes(run.attributes)
      piece = pad + piece + pad
    }
    output += piece
  }
  return output
}
