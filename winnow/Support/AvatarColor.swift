import SwiftUI

/// Stable polynomial hash of a sender string. Seeds avatar hues so the same
/// sender always renders the same color across launches.
private func hashSender(_ sender: String) -> Int {
    var hash = 0
    for ch in sender {
        hash = (hash * 31 + Int(ch.asciiValue ?? 0)) & 0x7fffffff
    }
    return hash
}

/// Avatar background color — `hsl(hash % 360, 55%, 50%)`.
func avatarColor(_ sender: String) -> Color {
    let hue = Double(hashSender(sender) % 360)
    return hslToColor(h: hue, s: 0.55, l: 0.50)
}

private func hslToColor(h: Double, s: Double, l: Double, a: Double = 1) -> Color {
    let c = (1 - abs(2 * l - 1)) * s
    let hp = h / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    let r1, g1, b1: Double
    switch hp {
    case 0..<1: (r1, g1, b1) = (c, x, 0)
    case 1..<2: (r1, g1, b1) = (x, c, 0)
    case 2..<3: (r1, g1, b1) = (0, c, x)
    case 3..<4: (r1, g1, b1) = (0, x, c)
    case 4..<5: (r1, g1, b1) = (x, 0, c)
    default: (r1, g1, b1) = (c, 0, x)
    }
    let m = l - c / 2
    return Color(red: r1 + m, green: g1 + m, blue: b1 + m, opacity: a)
}
