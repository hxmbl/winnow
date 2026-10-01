import Testing
@testable import winnow

@MainActor
struct ScoreAndFilterTests {

    // MARK: calculateWinnowScore

    @Test func everythingAtOnceClampsToAHundred() {
        let email = Fixtures.email(
            sender: "top@x.co",
            subject: "Urgent: verify your password",
            body: "Payment overdue. Please confirm your billing statement before the due date.",
            starred: true
        )
        let profile = Fixtures.profile(topSenders: ["top@x.co"])

        #expect(calculateWinnowScore(email: email, sig: Fixtures.signals(), profile: profile) == 100)
    }

    @Test func starringAddsExactlyFifteenPoints() {
        let plain = calculateWinnowScore(email: Fixtures.email(starred: false), sig: Fixtures.signals(), profile: Fixtures.profile())
        let starred = calculateWinnowScore(email: Fixtures.email(starred: true), sig: Fixtures.signals(), profile: Fixtures.profile())
        #expect(starred == plain + 15)
    }

    @Test func senderRankLadderRewardsTheFavorites() {
        let ranked = (0..<6).map { "\($0)@x.co" }
        let profile = Fixtures.profile(topSenders: ranked)
        let scores = ranked.map { calculateWinnowScore(email: Fixtures.email(sender: $0), sig: Fixtures.signals(), profile: profile) }
        #expect(scores == [68, 62, 62, 56, 56, 56])
    }

    @Test func heavyTrashBiasDragsTheScoreDown() {
        let sender = "maya@winnow.app"
        let profile = Fixtures.profile(trashBiasBySender: [sender: 0.5])   // capped at 0.35 → −14
        #expect(calculateWinnowScore(email: Fixtures.email(sender: sender), sig: Fixtures.signals(), profile: profile) == 36)
    }

    @Test func spamLikelihoodDragsTheSmartScoreDownLikeImportanceDoes() {
        let phishy = Fixtures.signals(spamLikelihood: 0.8)
        let clean = calculateWinnowScore(email: Fixtures.email(), sig: Fixtures.signals(), profile: Fixtures.profile())
        let flagged = calculateWinnowScore(email: Fixtures.email(), sig: phishy, profile: Fixtures.profile())
        #expect(clean == 50)
        #expect(flagged == clean - 32)   // 0.8 × 40
        #expect(flagged >= 0)
    }

    @Test func tierBoundariesStayInSyncWithSenderRankBonus() {
        let ranked = (0..<8).map { "\($0)@x.co" }
        let profile = Fixtures.profile(topSenders: ranked)
        for sender in ranked {
            let rank = profile.topSenders.firstIndex(of: sender)!
            let bonus = senderRankBonus(sender: sender, profile: profile, topBoost: 30)
            switch profile.tier(for: sender) {
            case 0: #expect(rank == 0 && bonus == 30)
            case 1: #expect((1...2).contains(rank) && bonus == 20)
            case 2: #expect((3...5).contains(rank) && bonus == 10)
            default: #expect(rank >= 6 && bonus == 0)
            }
        }
        #expect(profile.tier(for: "unranked@x.co") == 3)
    }

    // MARK: matchesSmartFilter buckets

    private func matches(_ filter: BuiltinSmartFilter, sig: EmailSignals) -> Bool {
        matches(filter, email: Fixtures.email(), sig: sig)
    }

    private func matches(_ filter: BuiltinSmartFilter, email: WinnowEmail, sig: EmailSignals) -> Bool {
        matches(filter, email: email, sig: sig, profile: Fixtures.profile())
    }

    private func matches(
        _ filter: BuiltinSmartFilter,
        email: WinnowEmail,
        sig: EmailSignals,
        profile: UserProfile
    ) -> Bool {
        matchesSmartFilter(filter: .builtin(filter), email: email, sig: sig, profile: profile)
    }

    @Test func importantBadgesAndTheImportantBucketCannotDisagree() {
        // The rail predicate and the row/viewer badges read the same cut. When
        // these drifted, messages sat in the Important pill with no Important
        // badge on the row, so the list looked like the filter was lying.
        for score in stride(from: 40, through: 90, by: 1) {
            let sig = Fixtures.signals(importanceScore: score)
            let inBucket = matchesBuiltin(.important, email: Fixtures.email(), sig: sig, profile: Fixtures.profile())
            let badged = sig.badgeFilters.contains(.important)
            let rowBadged = sig.rowIndicators.contains(.important)
            #expect(inBucket == badged, "badge/filter drift at importance \(score)")
            #expect(inBucket == rowBadged, "row indicator/filter drift at importance \(score)")
        }
    }

    @Test func importantThresholdIsTheDocumentedFiftySix() {
        #expect(EmailSignals.importantThreshold == 56)
    }

    @Test func starredBucketFollowsTheStar() {
        #expect(matches(.starred, email: Fixtures.email(starred: true), sig: Fixtures.signals()))
        #expect(!matches(.starred, email: Fixtures.email(), sig: Fixtures.signals(importanceScore: 90)))
    }

    @Test func importantNeedsHighScoreCleanOfBulkMail() {
        #expect(matches(.important, sig: Fixtures.signals(importanceScore: 60)))
        #expect(matches(.important, sig: Fixtures.signals(importanceScore: 56)))
        #expect(!matches(.important, sig: Fixtures.signals(importanceScore: 55)))
        #expect(!matches(.important, sig: Fixtures.signals(newsletter: true, importanceScore: 60)))
        #expect(!matches(.important, sig: Fixtures.signals(spamLikelihood: 0.4, importanceScore: 60)))
    }

    @Test func importantAlsoCatchesActionableMail() {
        #expect(matches(.important, sig: Fixtures.signals(needsAction: true, importanceScore: 40)))
        #expect(!matches(.important, sig: Fixtures.signals(promotional: true, needsAction: true)))
    }

    @Test func marketingUrgencyIsNotRealUrgencyUnlessFlagged() {
        let pressure = Fixtures.signals(promotional: true, urgentText: true)
        #expect(!matches(.urgent, sig: pressure))
        #expect(matches(.urgent, email: Fixtures.email(urgent: true), sig: pressure))

        #expect(matches(.urgent, sig: Fixtures.signals(urgentText: true)))
        #expect(!matches(.urgent, sig: Fixtures.signals(urgentText: true, spamLikelihood: 0.5)))
    }

    @Test func securityMirrorsItsSignalRegardlessOfSpam() {
        #expect(matches(.security, sig: Fixtures.signals(security: true)))
        #expect(matches(.security, sig: Fixtures.signals(security: true, spamLikelihood: 0.9)))
        #expect(!matches(.security, sig: Fixtures.signals()))
    }

    @Test func actionNeededExcludesNewslettersAndUnsafeMail() {
        #expect(matches(.needsAction, sig: Fixtures.signals(needsAction: true)))
        #expect(!matches(.needsAction, sig: Fixtures.signals(newsletter: true, needsAction: true)))
        #expect(!matches(.needsAction, sig: Fixtures.signals(needsAction: true, spamLikelihood: 0.4)))
    }

    @Test func receiptsRequireSafeFinanceSignals() {
        #expect(matches(.receipts, sig: Fixtures.signals(finance: true)))
        #expect(!matches(.receipts, sig: Fixtures.signals(finance: true, spamLikelihood: 0.5)))
        #expect(!matches(.receipts, sig: Fixtures.signals()))
    }

    @Test func bulkBucketsMirrorTheirFlagsDirectly() {
        #expect(matches(.newsletters, sig: Fixtures.signals(newsletter: true, spamLikelihood: 0.9)))
        #expect(!matches(.newsletters, sig: Fixtures.signals()))

        #expect(matches(.promotional, sig: Fixtures.signals(promotional: true, spamLikelihood: 0.9)))
        #expect(!matches(.promotional, sig: Fixtures.signals()))
    }

    @Test func readLaterIsGenuinelySkippableAndSafe() {
        let skippable = Fixtures.signals(importanceScore: 45)
        #expect(matches(.lowPriority, sig: skippable))

        #expect(!matches(.lowPriority, email: Fixtures.email(starred: true), sig: skippable))
        #expect(!matches(.lowPriority, sig: Fixtures.signals(urgentText: true, importanceScore: 45)))
        #expect(!matches(.lowPriority, sig: Fixtures.signals(security: true, importanceScore: 45)))
        #expect(!matches(.lowPriority, sig: Fixtures.signals(needsAction: true, importanceScore: 45)))
        #expect(!matches(.lowPriority, sig: Fixtures.signals(importanceScore: 50)))
        #expect(!matches(.lowPriority, sig: Fixtures.signals(spamLikelihood: 0.4, importanceScore: 45)))
    }

    @Test func unsafeStartsAtFortyPercentSpamLikelihood() {
        #expect(matches(.unsafe, sig: Fixtures.signals(spamLikelihood: 0.4)))
        #expect(!matches(.unsafe, sig: Fixtures.signals(spamLikelihood: 0.39)))
    }

    @Test func topContactsOnlyCoverTheFirstThreeRanks() {
        let profile = Fixtures.profile(topSenders: ["a@x.co", "b@x.co", "c@x.co", "d@x.co"])
        #expect(matches(.topContacts, email: Fixtures.email(sender: "a@x.co"), sig: Fixtures.signals(), profile: profile))
        #expect(matches(.topContacts, email: Fixtures.email(sender: "c@x.co"), sig: Fixtures.signals(), profile: profile))
        #expect(!matches(.topContacts, email: Fixtures.email(sender: "d@x.co"), sig: Fixtures.signals(), profile: profile))
    }

    @Test func quietContactsMirrorTheProfileList() {
        let profile = Fixtures.profile(quietSenders: ["rare@x.co"])
        #expect(matches(.quietContacts, email: Fixtures.email(sender: "rare@x.co"), sig: Fixtures.signals(), profile: profile))
        #expect(!matches(.quietContacts, email: Fixtures.email(sender: "busy@x.co"), sig: Fixtures.signals(), profile: profile))
    }

    @Test func codesBucketFollowsItsSignalAndStaysSafe() {
        #expect(matches(.codes, sig: Fixtures.signals(codes: true)))
        #expect(!matches(.codes, sig: Fixtures.signals(spamLikelihood: 0.4, codes: true)))
        #expect(!matches(.codes, sig: Fixtures.signals()))
    }

    @Test func shippingTravelAndEventsBucketsGateUnsafeMail() {
        #expect(matches(.shipping, sig: Fixtures.signals(shipping: true)))
        #expect(!matches(.shipping, sig: Fixtures.signals(spamLikelihood: 0.5, shipping: true)))

        #expect(matches(.travel, sig: Fixtures.signals(travel: true)))
        #expect(!matches(.travel, sig: Fixtures.signals(spamLikelihood: 0.5, travel: true)))

        #expect(matches(.events, sig: Fixtures.signals(events: true)))
        #expect(!matches(.events, sig: Fixtures.signals(spamLikelihood: 0.5, events: true)))
    }

    @Test func socialBucketFollowsItsSignalAndStaysSafe() {
        #expect(matches(.social, sig: Fixtures.signals(social: true)))
        #expect(!matches(.social, sig: Fixtures.signals(spamLikelihood: 0.5, social: true)))
        #expect(!matches(.social, sig: Fixtures.signals()))
    }

    @Test func unreadBucketFollowsTheReadState() {
        #expect(matches(.unread, email: Fixtures.email(unread: true), sig: Fixtures.signals()))
        #expect(!matches(.unread, email: Fixtures.email(unread: false), sig: Fixtures.signals()))
        #expect(!matches(.unread, email: Fixtures.email(unread: true), sig: Fixtures.signals(spamLikelihood: 0.4)))
    }

    @Test func attachmentsBucketNeedsACarriedFile() {
        let attachment = EmailAttachment(id: "a1", partId: "p1", filename: "invoice.pdf", mimeType: "application/pdf", size: 42)
        #expect(matches(.attachments, email: Fixtures.email(attachments: [attachment]), sig: Fixtures.signals()))
        #expect(!matches(.attachments, email: Fixtures.email(), sig: Fixtures.signals()))
        #expect(!matches(.attachments, email: Fixtures.email(attachments: [attachment]), sig: Fixtures.signals(spamLikelihood: 0.4)))
    }

    @Test func newContactsMirrorTheProfileList() {
        let profile = Fixtures.profile(firstTimeSenders: ["cold@x.co"])
        #expect(matches(.newSenders, email: Fixtures.email(sender: "cold@x.co"), sig: Fixtures.signals(), profile: profile))
        #expect(!matches(.newSenders, email: Fixtures.email(sender: "known@x.co"), sig: Fixtures.signals(), profile: profile))
    }

    @Test func longReadsRequireSubstantiveLowUrgencyMail() {
        #expect(matches(.longReads, sig: Fixtures.signals(longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(newsletter: true, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(promotional: true, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(urgentText: true, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(security: true, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(needsAction: true, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals(spamLikelihood: 0.4, longRead: true)))
        #expect(!matches(.longReads, sig: Fixtures.signals()))
    }

    @Test func senderFiltersMatchExactAddressesOnly() {
        #expect(matchesSmartFilter(filter: .sender("bob@x.co"), email: Fixtures.email(sender: "bob@x.co"), sig: Fixtures.signals(), profile: Fixtures.profile()))
        #expect(matchesSmartFilter(filter: .sender("BOB@X.CO"), email: Fixtures.email(sender: "bob@x.co"), sig: Fixtures.signals(), profile: Fixtures.profile()))
        #expect(!matchesSmartFilter(filter: .sender("bob@x.co"), email: Fixtures.email(sender: "alice@x.co"), sig: Fixtures.signals(), profile: Fixtures.profile()))
    }

    // MARK: Recency bonus (STO-140)

    /// The default (nil) context keeps the score recency-neutral so the exact
    /// values above — and single-message callers — are unaffected by age.
    @Test func identicalMailScoresIdenticallyWithoutARecencyContext() {
        let old = calculateWinnowScore(
            email: Fixtures.email(receivedAt: 1_000),
            sig: Fixtures.signals(),
            profile: Fixtures.profile()
        )
        let recent = calculateWinnowScore(
            email: Fixtures.email(receivedAt: 10_000_000_000),
            sig: Fixtures.signals(),
            profile: Fixtures.profile()
        )
        #expect(old == recent)
    }

    @Test func relativeRecencyBonusScalesNewestToFullAndOldestToZero() {
        let context = ScoreRecencyContext(oldestReceivedAt: 1_000, newestReceivedAt: 2_000_000)

        #expect(relativeRecencyBonus(receivedAt: 1_000, context: context) == 0)    // oldest edge
        #expect(relativeRecencyBonus(receivedAt: 2_000_000, context: context) == 3) // newest edge
        #expect(relativeRecencyBonus(receivedAt: 500_750, context: context) == 1) // ~25% → 0.75 rounds to 1
        #expect(relativeRecencyBonus(receivedAt: 1_000_500, context: context) == 2) // midpoint → 1.5 rounds to 2
        // Admissions outside the window clamp to its edges.
        #expect(relativeRecencyBonus(receivedAt: -5, context: context) == 0)
        #expect(relativeRecencyBonus(receivedAt: 99_000_000, context: context) == 3)
    }

    @Test func relativeRecencyBonusIsZeroWithoutAWindow() {
        #expect(relativeRecencyBonus(receivedAt: 5_000, context: nil) == 0)
        // A degenerate window (single timestamp) has nothing to prioritize.
        let single = ScoreRecencyContext(oldestReceivedAt: 5_000, newestReceivedAt: 5_000)
        #expect(relativeRecencyBonus(receivedAt: 5_000, context: single) == 0)
    }

    @Test func scoreRecencyWindowBuildsFromTimestamps() {
        // Milliseconds like mock mail, not the "current time" — the whole point
        // is the bonus never consults a wall clock.
        let timestamps = [5_000, 1_000_000_000, 3_000_000_000]
        let window = ScoreRecencyContext.window(of: timestamps)
        #expect(window?.oldestReceivedAt == 5_000)
        #expect(window?.newestReceivedAt == 3_000_000_000)
        #expect(ScoreRecencyContext.window(of: []) == nil)
    }

    @Test func newerMailOutranksIdenticalOlderMailInTheSameWindow() {
        let oldEmail = Fixtures.email(receivedAt: 1_000)
        let newEmail = Fixtures.email(receivedAt: 2_000_000)
        let context = ScoreRecencyContext.window(of: [oldEmail.receivedAt, newEmail.receivedAt])

        let oldScore = calculateWinnowScore(email: oldEmail, sig: Fixtures.signals(), profile: Fixtures.profile(), recency: context)
        let newScore = calculateWinnowScore(email: newEmail, sig: Fixtures.signals(), profile: Fixtures.profile(), recency: context)
        #expect(newScore == oldScore + 3)
    }

    @Test func recencyBonusIsRelativeBoundedAndNeverDrownsPriorities() {
        let timestamps = [1_000, 2_000, 1_000_000, 2_000_000, 5_000_000]
        let context = ScoreRecencyContext.window(of: timestamps)

        // Priority mail (top sender) keeps its lead over the newest anonymous mail.
        let priority = calculateWinnowScore(
            email: Fixtures.email(sender: "top@x.co", receivedAt: 1_000),
            sig: Fixtures.signals(),
            profile: Fixtures.profile(topSenders: ["top@x.co"]),
            recency: context
        )
        let newest = calculateWinnowScore(
            email: Fixtures.email(receivedAt: 5_000_000),
            sig: Fixtures.signals(),
            profile: Fixtures.profile(),
            recency: context
        )
        #expect(priority > newest)

        // Even the newest phish stays dragged below a clean 50.
        let phishy = calculateWinnowScore(
            email: Fixtures.email(receivedAt: 5_000_000),
            sig: Fixtures.signals(spamLikelihood: 0.8),
            profile: Fixtures.profile(),
            recency: context
        )
        #expect(phishy < 50)
        #expect(newest - phishy >= 30)
    }
}
