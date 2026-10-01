import Testing
@testable import winnow

@MainActor
struct ProfileTests {

    private func inbox(_ spec: [(sender: String, count: Int, starred: Int)]) -> [WinnowEmail] {
        var emails: [WinnowEmail] = []
        var nextID = 1
        for (sender, count, starredCount) in spec {
            for index in 0..<count {
                emails.append(Fixtures.email(id: nextID, sender: sender, starred: index < starredCount))
                nextID += 1
            }
        }
        return emails
    }

    @Test func topSendersRankByVolumeStarsAndTrashPenalty() {
        let inbox = inbox([
            ("alice@example.com", 4, 2),   // score 4 + 4 = 8
            ("bob@example.com", 1, 0),     // score 1
            ("carol@example.com", 2, 0),   // score 2 - 0.35 (one trash)
            ("erin@example.com", 10, 1)   // score 10 + 2 = 12
        ])
        let trash = [
            TrashRow(sender: "carol@example.com"),
            TrashRow(sender: "dave@example.com")
        ]
        let profile = buildUserProfile(inbox: inbox, trash: trash)

        #expect(profile.topSenders == [
            "erin@example.com",
            "alice@example.com",
            "carol@example.com",
            "bob@example.com"
        ])
    }

    @Test func trashBiasIsDiscardsOverDiscardsPlusInboxPlusOne() {
        let inbox = inbox([("carol@example.com", 2, 0)])
        let trash = [
            TrashRow(sender: "dave@example.com"),
            TrashRow(sender: "dave@example.com"),
            TrashRow(sender: "carol@example.com")
        ]
        let profile = buildUserProfile(inbox: inbox, trash: trash)

        #expect(profile.trashBiasBySender["dave@example.com"] == 2.0 / 3.0)   // 2 / (2 + 0 + 1)
        #expect(profile.trashBiasBySender["carol@example.com"] == 0.25)  // 1 / (1 + 2 + 1)
        #expect(profile.trashBiasBySender["erin@example.com"] == nil)
    }

    @Test func quietSendersAreTheRarestThirdCappedAtTwoEmails() {
        let inbox = inbox([
            ("busy@example.com", 9, 0),
            ("middle@example.com", 4, 0),
            ("rare1@example.com", 1, 0),
            ("rare2@example.com", 2, 0)
        ])
        let profile = buildUserProfile(inbox: inbox, trash: [])

        #expect(Set(profile.quietSenders) == ["rare1@example.com", "rare2@example.com"])
    }

    @Test func sendersWithThreeOrMoreEmailsNeverCountAsQuiet() {
        // Two senders → cut of one; the quietest still has four emails, so
        // nobody qualifies.
        let inbox = inbox([
            ("quietest@example.com", 4, 0),
            ("busiest@example.com", 8, 0)
        ])
        let profile = buildUserProfile(inbox: inbox, trash: [])

        #expect(profile.quietSenders.isEmpty)
    }

    @Test func topSendersAreCappedAtSixEntries() {
        var spec: [(String, Int, Int)] = []
        for index in 0..<7 {
            spec.append(("s\(index)@example.com", 7 - index, 0))
        }
        let profile = buildUserProfile(inbox: inbox(spec), trash: [])

        #expect(profile.topSenders.count == 6)
        #expect(profile.topSenders.first == "s0@example.com")
        #expect(!profile.topSenders.contains("s6@example.com"))
    }

    @Test func trashedOnlySendersStayOutOfEngagementLists() {
        let inbox = inbox([("maya@example.com", 1, 0)])
        let trash = [TrashRow(sender: "spam@example.com"), TrashRow(sender: "spam@example.com")]
        let profile = buildUserProfile(inbox: inbox, trash: trash)

        #expect(!profile.topSenders.contains("spam@example.com"))
        #expect(!profile.quietSenders.contains("spam@example.com"))
        #expect(profile.trashBiasBySender["spam@example.com"] == 2.0 / 3.0)
    }

    @Test func emptyInputsProduceAnEmptyProfile() {
        let profile = buildUserProfile(inbox: [], trash: [])

        #expect(profile.topSenders.isEmpty)
        #expect(profile.quietSenders.isEmpty)
        #expect(profile.trashBiasBySender.isEmpty)
        #expect(profile.firstTimeSenders.isEmpty)
    }

    @Test func firstTimeSendersAreSingleUnTrashedEmails() {
        let inbox = inbox([
            ("cold@example.com", 1, 0),          // one email, never trashed → first-timer
            ("recurring@example.com", 2, 0),     // two emails → not first-time
            ("discarded@example.com", 1, 0),     // one email but trashed → excluded
            ("busy@example.com", 5, 0)          // established sender
        ])
        let trash = [TrashRow(sender: "discarded@example.com")]
        let profile = buildUserProfile(inbox: inbox, trash: trash)

        #expect(profile.firstTimeSenders == ["cold@example.com"])
    }
}
