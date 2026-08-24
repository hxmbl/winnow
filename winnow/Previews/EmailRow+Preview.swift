#if DEBUG
import SwiftUI

private let rowWork = WinnowEmail(
    id: 9001,
    sender: "Figma",
    name: nil,
    email: "figma@email.com",
    receivedAt: 1778319000000,
    subject: "New comment",
    body: "Sarah left a comment on your latest design: \"The padding on the mobile view looks off.\"",
    type: "work",
    starred: true,
    urgent: false
)

private let rowSecurity = WinnowEmail(
    id: 9002,
    sender: "Chase Bank",
    name: nil,
    email: "chase.bank@email.com",
    receivedAt: 1778227200000,
    subject: "Alert: Unusual sign-in attempt",
    body: "We detected a sign-in attempt from an unrecognized device in Chicago, IL.",
    type: "security",
    starred: false,
    urgent: true
)

private let rowNewsletter = WinnowEmail(
    id: 9003,
    sender: "Borderless",
    name: nil,
    email: "newsletter@borderless.co",
    receivedAt: 1777878000000,
    subject: "Borderless Weekly: Issue #204",
    body: "This week: The rise of AI-native databases, a deep dive on WebGPU, and more.",
    type: "newsletter",
    starred: false,
    urgent: false
)

private let rowSpam = WinnowEmail(
    id: 9004,
    sender: "winner@lucky-draw.xyz",
    name: "Prize Winner",
    email: "winner@lucky-draw.xyz",
    receivedAt: 1778360400000,
    subject: "CONGRATULATIONS! YOU WON!!!",
    body: "You have won $1,000,000!!! Click here to claim your prize now!!!",
    type: "promotional",
    starred: false,
    urgent: false
)

private extension EmailSignals {
    static let important = EmailSignals(
        security: false, newsletter: false, promotional: false, urgentText: false,
        needsAction: true, finance: false, spamLikelihood: 0, importanceScore: 82
    )

    static let urgentSecurity = EmailSignals(
        security: true, newsletter: false, promotional: false, urgentText: true,
        needsAction: false, finance: false, spamLikelihood: 0, importanceScore: 88
    )

    static let newsletterish = EmailSignals(
        security: false, newsletter: true, promotional: false, urgentText: false,
        needsAction: false, finance: false, spamLikelihood: 0.1, importanceScore: 34
    )

    static let unsafePromo = EmailSignals(
        security: false, newsletter: false, promotional: true, urgentText: false,
        needsAction: false, finance: false, spamLikelihood: 0.85, importanceScore: 12
    )
}

#Preview("Rows") {
    List {
        EmailRow(email: rowWork, sig: .important)
        EmailRow(email: rowSecurity, sig: .urgentSecurity)
        EmailRow(email: rowNewsletter, sig: .newsletterish)
        EmailRow(email: rowSpam, sig: .unsafePromo)
    }
}

#Preview("Avatar & badges") {
    VStack(spacing: 24) {
        HStack(spacing: 16) {
            AvatarView(sender: "Figma", size: 36, font: .subheadline)
            AvatarView(sender: "Chase Bank", size: 48, font: .title3)
            AvatarView(sender: "winner@lucky-draw.xyz", size: 64, font: .largeTitle)
        }
        HStack(spacing: 20) {
            BadgeStack(sig: .important, starred: true, activeFilters: [.builtin(.important)])
            BadgeStack(sig: .urgentSecurity, starred: false)
            BadgeStack(sig: .unsafePromo, starred: false, activeFilters: [.builtin(.unsafe)])
        }
    }
    .padding(32)
}
#endif
