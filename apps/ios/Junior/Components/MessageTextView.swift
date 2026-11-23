import SwiftUI
import UIKit

/// The composer's text view. With `onSubmit`, Return sends, from the software
/// keyboard and from a hardware keyboard, and a newline comes from Shift-Return
/// on a hardware keyboard, from "New Line" in the edit menu, or from pasted
/// text. Without it, Return inserts a newline.
///
/// A SwiftUI `TextField` with a vertical axis cannot do this: Return always
/// inserts a newline, `onSubmit` never runs, and the field cannot tell
/// Shift-Return from Return.
struct MessageTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var focused: Bool
  let placeholder: String
  let onSubmit: (() -> Void)?

  /// 16pt Inter with the dashboard's `leading-relaxed` (1.625) line height.
  /// Computed so it follows Dynamic Type.
  private static var font: UIFont { Typography.uiFont(.sans, .base, weight: .regular) }
  private static var lineHeight: CGFloat { (font.pointSize * 1.625).rounded() }
  /// Lines before the view scrolls.
  private static let maxLines: CGFloat = 4

  private static var attributes: [NSAttributedString.Key: Any] {
    let font = font
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: font,
      .foregroundColor: UIColor(Tokens.text),
      .paragraphStyle: paragraph,
      // Center the glyphs in the line, as CSS does; UIKit puts the extra
      // height above them.
      .baselineOffset: (lineHeight - font.lineHeight) / 4,
    ]
  }

  func makeUIView(context: Context) -> ComposerTextView {
    let view = ComposerTextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.font = Self.font
    view.adjustsFontForContentSizeCategory = true
    if onSubmit != nil { view.returnKeyType = .send }
    view.tintColor = UIColor(Tokens.accent)
    view.typingAttributes = Self.attributes
    view.accessibilityLabel = placeholder
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: ComposerTextView, context: Context) {
    context.coordinator.parent = self
    view.accessibilityLabel = placeholder
    if view.text != text {
      view.attributedText = NSAttributedString(string: text, attributes: Self.attributes)
      view.typingAttributes = Self.attributes
    }
    // After the update: changing the first responder during one warns.
    if focused != view.isFirstResponder {
      let focus = focused
      Task { @MainActor in
        if focus { view.becomeFirstResponder() } else { view.resignFirstResponder() }
      }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ComposerTextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite else { return nil }
    let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    let lineHeight = Self.lineHeight
    let height = min(max(fitting, lineHeight), lineHeight * Self.maxLines)
    view.isScrollEnabled = fitting > height
    return CGSize(width: width, height: height)
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: MessageTextView

    init(_ parent: MessageTextView) { self.parent = parent }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool {
      guard let onSubmit = parent.onSubmit, replacementText == "\n",
        let view = textView as? ComposerTextView, !view.insertingLineBreak,
        // Return commits a marked (IME) text first.
        textView.markedTextRange == nil
      else { return true }
      // The composer decides whether the text can send; Return never adds a newline.
      onSubmit()
      return false
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.text != textView.text { parent.text = textView.text }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.focused { parent.focused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.focused { parent.focused = false }
    }

    func textView(
      _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
      guard parent.onSubmit != nil, let view = textView as? ComposerTextView else { return nil }
      let newLine = UIAction(title: "New Line", image: UIImage(systemName: "return")) { [weak view] _ in
        view?.insertLineBreak()
      }
      return UIMenu(children: suggestedActions + [newLine])
    }
  }
}

/// Inserts a newline on Shift-Return from a hardware keyboard. Plain Return
/// reaches the text system, which asks the delegate, which sends.
final class ComposerTextView: UITextView {
  private(set) var insertingLineBreak = false
  private var swallowed: Set<UIPress> = []

  /// Insert a newline at the cursor; the delegate lets this one through.
  func insertLineBreak() {
    insertingLineBreak = true
    defer { insertingLineBreak = false }
    insertText("\n")
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let lineBreaks = presses.filter { press in
      guard let key = press.key, key.keyCode == .keyboardReturnOrEnter else { return false }
      return key.modifierFlags.contains(.shift) && markedTextRange == nil
    }
    guard !lineBreaks.isEmpty else { return super.pressesBegan(presses, with: event) }
    swallowed.formUnion(lineBreaks)
    insertLineBreak()
    let rest = presses.subtracting(lineBreaks)
    if !rest.isEmpty { super.pressesBegan(rest, with: event) }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    forward(presses) { super.pressesEnded($0, with: event) }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    forward(presses) { super.pressesCancelled($0, with: event) }
  }

  /// Keep the end of a swallowed press from the text system too.
  private func forward(_ presses: Set<UIPress>, _ send: (Set<UIPress>) -> Void) {
    let rest = presses.subtracting(swallowed)
    swallowed.subtract(presses)
    if !rest.isEmpty { send(rest) }
  }
}
