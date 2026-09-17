import Testing
@testable import winnow

@MainActor
struct ClassificationTests {

    // MARK: Signal detection

    @Test func quietMailCarriesNoSignalsAndScoresFifty() {
        let sig = Fixtures.classify(Fixtures.email())

        #expect(!sig.security)
        #expect(!sig.newsletter)
        #expect(!sig.promotional)
        #expect(!sig.urgentText)
        #expect(!sig.needsAction)
        #expect(!sig.finance)
        #expect(sig.spamLikelihood == 0)
        #expect(sig.importanceScore == 50)
    }

    @Test func securityPhrasesFlagSecurity() {
        let sig = Fixtures.classify(Fixtures.email(subject: "Security alert", body: "Unusual activity detected."))
        #expect(sig.security)
        #expect(!sig.needsAction)
        #expect(sig.importanceScore == 66)   // 50 + security weight
    }

    @Test func securityTypeFlagsSecurityWithoutAnyKeyword() {
        let sig = Fixtures.classify(Fixtures.email(type: "security"))
        #expect(sig.security)
        #expect(sig.importanceScore == 66)
    }

    @Test func newsletterTypeAloneFlagsNewsletter() {
        let sig = Fixtures.classify(Fixtures.email(type: "newsletter"))
        #expect(sig.newsletter)
        #expect(sig.importanceScore == 41)   // 50 - newsletter penalty
    }

    @Test func newsletterNeedsTwoKeywordHits() {
        let singleHit = Fixtures.classify(Fixtures.email(body: "You can unsubscribe at any time."))
        #expect(!singleHit.newsletter)
        #expect(singleHit.importanceScore == 50)

        let twoHits = Fixtures.classify(Fixtures.email(body: "Unsubscribe or manage preferences anytime."))
        #expect(twoHits.newsletter)
        #expect(twoHits.importanceScore == 41)
    }

    @Test func promoRegexFlagsPromotional() {
        let sig = Fixtures.classify(Fixtures.email(body: "Flash sale! Everything is 20% off today only."))
        #expect(sig.promotional)
        #expect(!sig.finance)
        #expect(sig.importanceScore == 39)   // 50 - promo penalty
    }

    @Test func securityNoticesAreNeverPromotional() {
        let sig = Fixtures.classify(
            Fixtures.email(subject: "Security alert", body: "Suspicious activity: coupon code for 20% off.")
        )
        #expect(sig.security)
        #expect(!sig.promotional)
        #expect(sig.importanceScore == 66)
    }

    @Test func urgencyComesFromTheFlagOrTheText() {
        let flagged = Fixtures.classify(Fixtures.email(urgent: true))
        #expect(flagged.urgentText)
        #expect(flagged.needsAction == false)
        #expect(flagged.importanceScore == 68)   // 50 + urgency weight

        let written = Fixtures.classify(Fixtures.email(body: "Reply ASAP please."))
        #expect(written.urgentText)
        #expect(!written.needsAction)
        #expect(written.importanceScore == 68)
    }

    @Test func replyRequestsFlagNeedsAction() {
        let sig = Fixtures.classify(Fixtures.email(body: "Could you review the draft?"))
        #expect(sig.needsAction)
        #expect(sig.importanceScore == 62)   // 50 + action-needed weight
    }

    @Test func newslettersNeverNeedActionViaReplyRequests() {
        let sig = Fixtures.classify(
            Fixtures.email(body: "Could you review our latest issue? Unsubscribe anytime.", type: "newsletter")
        )
        #expect(sig.newsletter)
        #expect(!sig.needsAction)
    }

    @Test func explicitActionVerbsStillFlagNewsletters() {
        let sig = Fixtures.classify(Fixtures.email(body: "Confirm your appointment this week.", type: "newsletter"))
        #expect(sig.newsletter)
        #expect(sig.needsAction)
        #expect(sig.importanceScore == 53)   // 50 - newsletter + action
    }

    @Test func transactionalLanguageFlagsFinance() {
        let sig = Fixtures.classify(Fixtures.email(body: "Your invoice #1042 is attached."))
        #expect(sig.finance)
        #expect(!sig.needsAction)
        #expect(sig.importanceScore == 57)   // 50 + finance weight
    }

    @Test func financeIsSuppressedForSecurityNotices() {
        let sig = Fixtures.classify(
            Fixtures.email(subject: "Security alert", body: "Invoice dispute detected on your account.")
        )
        #expect(sig.security)
        #expect(!sig.finance)
    }

    @Test func financeIsSuppressedForPromotions() {
        let sig = Fixtures.classify(Fixtures.email(body: "20% off. Invoice enclosed for extra savings."))
        #expect(sig.promotional)
        #expect(!sig.finance)
        #expect(sig.importanceScore == 39)
    }

    // MARK: Spam likelihood

    @Test func emptySubjectAndBodyReadAsSpam() {
        let sig = Fixtures.classify(Fixtures.email(subject: "", body: ""))
        #expect(abs(sig.spamLikelihood - 0.55) < 0.0001)
    }

    @Test func missingSubjectAloneCostsLess() {
        let sig = Fixtures.classify(Fixtures.email(subject: "", body: "Hello there."))
        #expect(abs(sig.spamLikelihood - 0.2) < 0.0001)
    }

    @Test func phishingPhrasesRaiseSpamSharply() {
        let sig = Fixtures.classify(Fixtures.email(body: "Click here to confirm your identity."))
        #expect(abs(sig.spamLikelihood - 0.3) < 0.0001)
        #expect(!sig.security)
    }

    @Test func classicSpamWordsRaiseSpam() {
        let sig = Fixtures.classify(Fixtures.email(body: "Claim your prize now!"))
        #expect(abs(sig.spamLikelihood - 0.15) < 0.0001)
    }

    @Test func senderReputationHeuristicsStackIndependently() {
        let exampleDomain = Fixtures.classify(Fixtures.email(sender: "bill@updates.example.com"))
        #expect(abs(exampleDomain.spamLikelihood - 0.18) < 0.0001)

        let numericDomain = Fixtures.classify(Fixtures.email(sender: "spam@mail77.io"))
        #expect(abs(numericDomain.spamLikelihood - 0.1) < 0.0001)

        let noreplyNewsletter = Fixtures.classify(Fixtures.email(sender: "noreply@news.co", type: "newsletter"))
        #expect(abs(noreplyNewsletter.spamLikelihood - 0.05) < 0.0001)

        let marketing = Fixtures.classify(Fixtures.email(sender: "marketing@shop.io"))
        #expect(abs(marketing.spamLikelihood - 0.05) < 0.0001)
    }

    @Test func shoutySubjectsAddSpam() {
        let sig = Fixtures.classify(Fixtures.email(subject: "FINAL NOTICE!!", body: "See attachment."))
        #expect(abs(sig.spamLikelihood - 0.12) < 0.0001)
    }

    @Test func trashBiasInfluenceCapsAtThirtyFivePercent() {
        let biasedProfile = Fixtures.profile(trashBiasBySender: ["maya@winnow.app": 0.9])
        let sig = Fixtures.classify(Fixtures.email(), profile: biasedProfile)
        #expect(abs(sig.spamLikelihood - (0.35 * 0.22)) < 0.0001)
    }

    // MARK: Importance arithmetic

    @Test func starringAddsTheStarBoost() {
        let starred = Fixtures.classify(Fixtures.email(starred: true))
        #expect(starred.importanceScore == 72)   // 50 + star boost
    }

    @Test func zeroedWeightsNeutralizeEveryContribution() {
        var weights = SignalWeights()
        for key in SignalKey.allCases { weights[keyPath: key.keyPath] = 0 }
        let sig = Fixtures.classify(Fixtures.email(starred: true), weights: weights)
        #expect(sig.importanceScore == 50)
    }

    @Test func spamSensitivityControlsHowHardSpamDrags() {
        let phishy = Fixtures.email(body: "Click here to confirm your identity.")

        #expect(Fixtures.classify(phishy).importanceScore == 37)

        var insensitive = SignalWeights()
        insensitive.spamSensitivity = 0
        #expect(Fixtures.classify(phishy, weights: insensitive).importanceScore == 50)
    }

    @Test func senderRankLadderScalesFromTheTopBoost() {
        let rankedSenders = (0..<6).map { "\($0)@x.co" }
        let profile = Fixtures.profile(topSenders: rankedSenders)
        let bonuses = rankedSenders.map { sender in
            Fixtures.classify(Fixtures.email(sender: sender), profile: profile).importanceScore
        }
        #expect(bonuses == [68, 62, 62, 56, 56, 56])   // full boost, ⅔, then ⅓

        let unknown = Fixtures.classify(Fixtures.email(sender: "z@x.co"), profile: profile)
        #expect(unknown.importanceScore == 50)
    }

    @Test func quietContactsTakeAPenalty() {
        let profile = Fixtures.profile(quietSenders: ["maya@winnow.app"])
        let sig = Fixtures.classify(Fixtures.email(), profile: profile)
        #expect(sig.importanceScore == 44)   // 50 - quiet-contact penalty
    }

    // MARK: New semantic signals

    @Test func oneTimeCodePhrasesFlagCodes() {
        let sig = Fixtures.classify(Fixtures.email(subject: "Your verification code", body: "Use 884213 to sign in. It expires in 10 minutes."))
        #expect(sig.codes)
        #expect(!sig.security)
    }

    @Test func codesAreSuppressedForSecurityNotices() {
        let sig = Fixtures.classify(Fixtures.email(subject: "Security alert", body: "Someone requested a verification code for your account."))
        #expect(sig.security)
        #expect(!sig.codes)
    }

    @Test func trackingLanguageFlagsShipping() {
        let sig = Fixtures.classify(Fixtures.email(subject: "Your package is on its way", body: "Tracking number 1Z999AA1. Delivery date: Thursday."))
        #expect(sig.shipping)
        #expect(!sig.promotional)
    }

    @Test func itineraryLanguageFlagsTravel() {
        let sig = Fixtures.classify(Fixtures.email(subject: "Your flight is confirmed", body: "Here is your itinerary and boarding pass for next week."))
        #expect(sig.travel)
    }

    @Test func invitationLanguageFlagsEvents() {
        let sig = Fixtures.classify(Fixtures.email(subject: "You're invited: design review", body: "Join our webinar on Friday. Please RSVP."))
        #expect(sig.events)
    }

    @Test func socialDomainsFlagSocialWithoutKeywords() {
        let sig = Fixtures.classify(Fixtures.email(sender: "no-reply@linkedin.com", subject: "A new post from your network", body: "See what's new."))
        #expect(sig.social)
    }

    @Test func longBodiesFlagLongReads() {
        let short = Fixtures.classify(Fixtures.email(body: "Short note."))
        #expect(!short.longRead)

        let longBody = Array(repeating: "word", count: 250).joined(separator: " ")
        let long = Fixtures.classify(Fixtures.email(body: longBody))
        #expect(long.longRead)
    }
}
