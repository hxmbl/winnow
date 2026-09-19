import Foundation
import Testing
@testable import winnow

struct AvatarProviderTests {
    private let provider = GravatarAvatarProvider()

    @Test func bareEmailProducesTheSpecCompliantURL() throws {
        let url = try #require(provider.avatarURL(for: "maya@winnow.app", size: 36))
        #expect(url.absoluteString == "https://www.gravatar.com/avatar/f5e23b7d81209ec40841b8b7755d5d4d?s=36&d=404&r=g")
    }

    @Test func displayNameWrappedEmailsResolveToTheSameAccount() throws {
        let bare = try #require(provider.avatarURL(for: "maya@winnow.app", size: 36))
        let named = try #require(provider.avatarURL(for: "Maya Chen <maya@winnow.app>", size: 36))
        let quoted = try #require(provider.avatarURL(for: "\"Maya Chen\" <maya@winnow.app>", size: 36))
        #expect(bare == named)
        #expect(bare == quoted)
    }

    @Test func normalizationMatchesGravatarsLowercasingAndTrimmingRule() throws {
        let exact = try #require(provider.avatarURL(for: "Maya@Winnow.app", size: 48))
        let padded = try #require(provider.avatarURL(for: "  maya@winnow.app  ", size: 48))
        #expect(exact == padded)
        #expect(exact.absoluteString.contains("s=48"))
    }

    @Test func displayOnlySendersHaveNoGravatarAndFallBackToInitials() {
        #expect(provider.avatarURL(for: "Figma", size: 36) == nil)
        #expect(provider.avatarURL(for: "", size: 36) == nil)
        #expect(provider.avatarURL(for: "   ", size: 36) == nil)
    }

    @Test func emailExtractionPicksTheFirstAddress() {
        #expect(GravatarAvatarProvider.email(in: "maya@winnow.app") == "maya@winnow.app")
        #expect(GravatarAvatarProvider.email(in: "Maya Chen <maya@winnow.app>") == "maya@winnow.app")
        #expect(GravatarAvatarProvider.email(in: "maya@winnow.app + other@elsewhere.io") == "maya@winnow.app")
        #expect(GravatarAvatarProvider.email(in: "no address here") == nil)
    }
}
