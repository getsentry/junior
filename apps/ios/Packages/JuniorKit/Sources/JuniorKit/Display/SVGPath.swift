import CoreGraphics
import Foundation

/// Parse SVG path data (`d`) into a CGPath, so the app draws the same
/// Octicons and brand marks as the dashboard. Supports every path command;
/// arcs become cubic Béziers.
public func svgPath(_ data: String) -> CGPath {
  var scanner = PathScanner(Array(data.utf8))
  let path = CGMutablePath()
  var current = CGPoint.zero
  var start = CGPoint.zero
  var lastControl: CGPoint?
  var lastQuad: CGPoint?
  var command: UInt8 = 0

  while let next = scanner.nextCommand(previous: command) {
    command = next
    let relative = command >= 97
    let base = relative ? current : .zero
    func point() -> CGPoint? {
      guard let x = scanner.number(), let y = scanner.number() else { return nil }
      return CGPoint(x: base.x + x, y: base.y + y)
    }
    switch command | 0x20 {
    case UInt8(ascii: "m"):
      guard let p = point() else { return path }
      path.move(to: p)
      current = p
      start = p
      // Extra coordinate pairs after a move are line-tos.
      command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
      lastControl = nil
      lastQuad = nil
    case UInt8(ascii: "l"):
      guard let p = point() else { return path }
      path.addLine(to: p)
      current = p
      lastControl = nil
      lastQuad = nil
    case UInt8(ascii: "h"):
      guard let x = scanner.number() else { return path }
      current = CGPoint(x: relative ? current.x + x : x, y: current.y)
      path.addLine(to: current)
      lastControl = nil
      lastQuad = nil
    case UInt8(ascii: "v"):
      guard let y = scanner.number() else { return path }
      current = CGPoint(x: current.x, y: relative ? current.y + y : y)
      path.addLine(to: current)
      lastControl = nil
      lastQuad = nil
    case UInt8(ascii: "c"):
      guard let c1 = point(), let c2 = point(), let p = point() else { return path }
      path.addCurve(to: p, control1: c1, control2: c2)
      current = p
      lastControl = c2
      lastQuad = nil
    case UInt8(ascii: "s"):
      guard let c2 = point(), let p = point() else { return path }
      let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
      path.addCurve(to: p, control1: c1, control2: c2)
      current = p
      lastControl = c2
      lastQuad = nil
    case UInt8(ascii: "q"):
      guard let c = point(), let p = point() else { return path }
      path.addQuadCurve(to: p, control: c)
      current = p
      lastQuad = c
      lastControl = nil
    case UInt8(ascii: "t"):
      guard let p = point() else { return path }
      let c = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
      path.addQuadCurve(to: p, control: c)
      current = p
      lastQuad = c
      lastControl = nil
    case UInt8(ascii: "a"):
      guard let rx = scanner.number(), let ry = scanner.number(), let rotation = scanner.number(),
        let large = scanner.flag(), let sweep = scanner.flag(), let p = point()
      else { return path }
      addArc(
        to: path, from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
      current = p
      lastControl = nil
      lastQuad = nil
    case UInt8(ascii: "z"):
      path.closeSubpath()
      current = start
      lastControl = nil
      lastQuad = nil
    default:
      return path
    }
  }
  return path
}

private struct PathScanner {
  let bytes: [UInt8]
  var index = 0

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  mutating func skipSeparators() {
    while index < bytes.count, [32, 9, 10, 13, 44].contains(bytes[index]) { index += 1 }
  }

  /// The next command letter, or the previous one when numbers repeat it.
  mutating func nextCommand(previous: UInt8) -> UInt8? {
    skipSeparators()
    guard index < bytes.count else { return nil }
    let byte = bytes[index]
    if (65...90).contains(byte) || (97...122).contains(byte) {
      index += 1
      return byte
    }
    return previous == 0 || previous | 0x20 == UInt8(ascii: "z") ? nil : previous
  }

  mutating func flag() -> Bool? {
    skipSeparators()
    guard index < bytes.count else { return nil }
    let byte = bytes[index]
    guard byte == 48 || byte == 49 else { return nil }
    index += 1
    return byte == 49
  }

  mutating func number() -> CGFloat? {
    skipSeparators()
    let begin = index
    if index < bytes.count, bytes[index] == 45 || bytes[index] == 43 { index += 1 }
    var seenDot = false
    var seenExponent = false
    while index < bytes.count {
      let byte = bytes[index]
      if (48...57).contains(byte) {
        index += 1
      } else if byte == 46, !seenDot, !seenExponent {
        seenDot = true
        index += 1
      } else if byte == 101 || byte == 69, !seenExponent {
        seenExponent = true
        index += 1
        if index < bytes.count, bytes[index] == 45 || bytes[index] == 43 { index += 1 }
      } else {
        break
      }
    }
    guard index > begin, let text = String(bytes: bytes[begin..<index], encoding: .ascii),
      let value = Double(text)
    else { return nil }
    return CGFloat(value)
  }
}

/// Endpoint-parameterized SVG arc to center form, then cubic Béziers.
private func addArc(
  to path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx: CGFloat, ry: CGFloat,
  rotation: CGFloat, large: Bool, sweep: Bool
) {
  var rx = abs(rx)
  var ry = abs(ry)
  guard rx > 0, ry > 0, p0 != p1 else {
    path.addLine(to: p1)
    return
  }
  let phi = rotation * .pi / 180
  let cosPhi = cos(phi)
  let sinPhi = sin(phi)
  let dx = (p0.x - p1.x) / 2
  let dy = (p0.y - p1.y) / 2
  let x1 = cosPhi * dx + sinPhi * dy
  let y1 = -sinPhi * dx + cosPhi * dy
  let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if lambda > 1 {
    rx *= sqrt(lambda)
    ry *= sqrt(lambda)
  }
  let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  var factor = sqrt(max(0, numerator / denominator))
  if large == sweep { factor = -factor }
  let cx1 = factor * rx * y1 / ry
  let cy1 = -factor * ry * x1 / rx
  let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
  let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2

  func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
    let dot = ux * vx + uy * vy
    let length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
    var value = acos(max(-1, min(1, dot / length)))
    if ux * vy - uy * vx < 0 { value = -value }
    return value
  }
  let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if !sweep, delta > 0 { delta -= 2 * .pi }
  if sweep, delta < 0 { delta += 2 * .pi }

  let segments = Int(ceil(abs(delta) / (.pi / 2)))
  let step = delta / CGFloat(segments)
  let kappa = 4 / 3 * tan(step / 4)
  func point(_ t: CGFloat) -> CGPoint {
    CGPoint(
      x: cx + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi,
      y: cy + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi)
  }
  func derivative(_ t: CGFloat) -> CGPoint {
    CGPoint(
      x: -rx * sin(t) * cosPhi - ry * cos(t) * sinPhi,
      y: -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi)
  }
  var t = theta1
  for _ in 0..<segments {
    let start = point(t)
    let end = point(t + step)
    let d1 = derivative(t)
    let d2 = derivative(t + step)
    path.addCurve(
      to: end,
      control1: CGPoint(x: start.x + kappa * d1.x, y: start.y + kappa * d1.y),
      control2: CGPoint(x: end.x - kappa * d2.x, y: end.y - kappa * d2.y))
    t += step
  }
}
