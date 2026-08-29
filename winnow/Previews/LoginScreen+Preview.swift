#if DEBUG
import SwiftUI

#Preview("Sign-in · Light") {
    LoginScreen(onSignIn: {})
        .preferredColorScheme(.light)
}

#Preview("Sign-in · Dark") {
    LoginScreen(onSignIn: {})
        .preferredColorScheme(.dark)
}

#Preview("Sign-in · Connecting") {
    LoginScreen(onSignIn: {}, onCancelSignIn: {}, isSigningIn: true)
}

#Preview("Sign-in · Error") {
    LoginScreen(
        onSignIn: {},
        errorMessage: "Gmail API returned HTTP 403."
    )
}

#Preview("Sign-in · Wide window") {
    LoginScreen(onSignIn: {})
        .frame(width: 1100, height: 700)
}
#endif
