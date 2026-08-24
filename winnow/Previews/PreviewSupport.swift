#if DEBUG
import Foundation

extension WinnowStore {
    /// Signed-in store on the stock mock inbox, for Xcode previews only.
    static var preview: WinnowStore {
        let store = WinnowStore()
        store.authed = true
        return store
    }
}
#endif
