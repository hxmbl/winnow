import Foundation
@testable import winnow

/// Shared builders so every suite crafts its own minimal fixtures instead of
/// reaching into the generated mock data. A mock-data regeneration therefore
/// can never silently break these tests.
@MainActor
enum Fixtures {

    /// A quiet, signal-free baseline email: no keywords, clean sender, no stars.
    /// Classifies to all-false flags, spam likelihood 0, importance 50.
    static func email(
        id: Int = 1,
        sender: String = "maya@winnow.app",
        name: String? = nil,
        receivedAt: Int = 1_000,
        subject: String = "Lunch tomorrow?",
        body: String = "Want to grab lunch at noon?",
        type: String = "work",
        starred: Bool = false,
        urgent: Bool = false,
        unread: Bool = false
    ) -> WinnowEmail {
        WinnowEmail(
            id: id,
            sender: sender,
            name: name,
            email: nil,
            receivedAt: receivedAt,
            subject: subject,
            body: body,
            type: type,
            starred: starred,
            urgent: urgent,
            unread: unread
        )
    }

    static func profile(
        trashBiasBySender: [String: Double] = [:],
        topSenders: [String] = [],
        quietSenders: [String] = []
    ) -> UserProfile {
        UserProfile(
            trashBiasBySender: trashBiasBySender,
            topSenders: topSenders,
            quietSenders: quietSenders
        )
    }

    static func signals(
        security: Bool = false,
        newsletter: Bool = false,
        promotional: Bool = false,
        urgentText: Bool = false,
        needsAction: Bool = false,
        finance: Bool = false,
        spamLikelihood: Double = 0,
        importanceScore: Int = 50
    ) -> EmailSignals {
        EmailSignals(
            security: security,
            newsletter: newsletter,
            promotional: promotional,
            urgentText: urgentText,
            needsAction: needsAction,
            finance: finance,
            spamLikelihood: spamLikelihood,
            importanceScore: importanceScore
        )
    }

    static func classify(_ email: WinnowEmail) -> EmailSignals {
        classifyEmail(email: email, profile: profile())
    }

    static func classify(_ email: WinnowEmail, profile: UserProfile) -> EmailSignals {
        classifyEmail(email: email, profile: profile)
    }

    static func classify(_ email: WinnowEmail, weights: SignalWeights) -> EmailSignals {
        classifyEmail(email: email, profile: profile(), weights: weights)
    }
}
