import SwiftUI

extension Color {
    static var winnowCard: Color { Color(NSColor.controlBackgroundColor) }
    static var winnowBackground: Color { Color(NSColor.windowBackgroundColor) }
    static var winnowBorder: Color { Color(NSColor.separatorColor) }
    static var winnowText: Color { Color(NSColor.textColor) }
    static var winnowSecondary: Color { Color(NSColor.secondaryLabelColor) }
}

/// Colors for a built-in filter's pill and badge.
struct FilterPalette {
    let bg: Color
    let border: Color
    let text: Color
}

private func rgba(_ red: Int, _ green: Int, _ blue: Int, _ alpha: Double) -> Color {
    Color(
        red: Double(red) / 255,
        green: Double(green) / 255,
        blue: Double(blue) / 255,
        opacity: alpha
    )
}

/// Built-in filter palettes — pastel tints matched to each bucket's meaning.
let builtinFilterPalettes: [BuiltinSmartFilter: FilterPalette] = [
    .important: FilterPalette(bg: rgba(251, 191, 36, 0.52), border: rgba(251, 191, 36, 0.56), text: rgba(120, 53, 15, 1)),
    .urgent: FilterPalette(bg: rgba(251, 113, 133, 0.54), border: rgba(251, 113, 133, 0.62), text: rgba(136, 19, 55, 1)),
    .security: FilterPalette(bg: rgba(125, 211, 252, 0.5), border: rgba(56, 189, 248, 0.54), text: rgba(12, 74, 110, 1)),
    .needsAction: FilterPalette(bg: rgba(45, 212, 191, 0.5), border: rgba(20, 184, 166, 0.56), text: rgba(19, 78, 74, 1)),
    .receipts: FilterPalette(bg: rgba(165, 180, 252, 0.5), border: rgba(129, 140, 248, 0.54), text: rgba(49, 46, 129, 1)),
    .codes: FilterPalette(bg: rgba(244, 114, 182, 0.5), border: rgba(236, 72, 153, 0.56), text: rgba(131, 24, 67, 1)),
    .shipping: FilterPalette(bg: rgba(190, 242, 100, 0.55), border: rgba(163, 230, 53, 0.6), text: rgba(54, 83, 20, 1)),
    .travel: FilterPalette(bg: rgba(34, 211, 238, 0.42), border: rgba(6, 182, 212, 0.5), text: rgba(12, 74, 110, 1)),
    .events: FilterPalette(bg: rgba(232, 121, 249, 0.45), border: rgba(217, 70, 239, 0.5), text: rgba(112, 26, 117, 1)),
    .social: FilterPalette(bg: rgba(96, 165, 250, 0.45), border: rgba(59, 130, 246, 0.5), text: rgba(30, 58, 138, 1)),
    .starred: FilterPalette(bg: rgba(250, 204, 21, 0.53), border: rgba(234, 179, 8, 0.58), text: rgba(113, 63, 18, 1)),
    .topContacts: FilterPalette(bg: rgba(167, 139, 250, 0.5), border: rgba(139, 92, 246, 0.54), text: rgba(76, 29, 149, 1)),
    .quietContacts: FilterPalette(bg: rgba(191, 219, 254, 0.48), border: rgba(147, 197, 253, 0.5), text: rgba(30, 64, 175, 1)),
    .newsletters: FilterPalette(bg: rgba(209, 213, 219, 0.54), border: rgba(156, 163, 175, 0.52), text: rgba(55, 65, 81, 1)),
    .promotional: FilterPalette(bg: rgba(74, 222, 128, 0.55), border: rgba(34, 197, 94, 0.58), text: rgba(21, 128, 61, 1)),
    .lowPriority: FilterPalette(bg: rgba(226, 232, 240, 0.58), border: rgba(148, 163, 184, 0.5), text: rgba(51, 65, 85, 1)),
    .longReads: FilterPalette(bg: rgba(205, 127, 50, 0.4), border: rgba(160, 82, 45, 0.5), text: rgba(87, 43, 22, 1)),
    .unread: FilterPalette(bg: rgba(148, 163, 184, 0.45), border: rgba(100, 116, 139, 0.5), text: rgba(30, 41, 59, 1)),
    .attachments: FilterPalette(bg: rgba(214, 158, 46, 0.45), border: rgba(180, 125, 25, 0.52), text: rgba(84, 50, 6, 1)),
    .newSenders: FilterPalette(bg: rgba(248, 113, 113, 0.45), border: rgba(239, 68, 68, 0.5), text: rgba(127, 29, 29, 1)),
    .unsafe: FilterPalette(bg: rgba(253, 186, 116, 0.53), border: rgba(251, 146, 60, 0.58), text: rgba(124, 45, 18, 1))
]

extension BuiltinSmartFilter {
    /// Palette for this bucket's pill/badge. Force-unwrap is safe because
    /// `builtinFilterPalettes` is defined for every case.
    var palette: FilterPalette { builtinFilterPalettes[self]! }

    /// SF Symbol standing in for the lucide icon used in the source design.
    var iconName: String {
        switch self {
        case .important: return "flag"
        case .urgent: return "bell.badge"
        case .security: return "shield"
        case .needsAction: return "checklist"
        case .receipts: return "doc.text"
        case .codes: return "number"
        case .shipping: return "shippingbox"
        case .travel: return "airplane"
        case .events: return "calendar"
        case .social: return "person.3"
        case .starred: return "star"
        case .topContacts: return "person.2"
        case .quietContacts: return "person.crop.circle.badge.xmark"
        case .newsletters: return "newspaper"
        case .promotional: return "tag"
        case .lowPriority: return "tray.full"
        case .longReads: return "book"
        case .unread: return "envelope.badge"
        case .attachments: return "paperclip"
        case .newSenders: return "person.badge.plus"
        case .unsafe: return "exclamationmark.triangle"
        }
    }
}
