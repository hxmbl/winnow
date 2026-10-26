# Changelog

All notable changes to Winnow are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each version's section is its release notes: the release workflow puts it at the top
of the GitHub release ("What's new", above Downloads) and in `latest.json`'s `notes`.
A version without a section is not released. Write changes under **Unreleased** as
they land; `web/scripts/bump-version.mjs` moves them under the new version. A stable
version's section covers everything since the previous stable version, so people who
skipped the betas see it all; a pre-release's section covers what that pre-release
adds. See `native/README.md`, "Cutting a release".

## [Unreleased]

### Changed

- Syncing no longer pushes the app down. The "Syncing 1 change…" bar across the top is now a small spinner beside the status pill (or where the pill sits), and it only appears when a sync takes more than a moment. Changes waiting offline show as a small cloud in the same place; hover it to read why.

## [1.6.3] - 2026-10-25

A security release, with one small change to how accounts look.

### Changed

- The account you're in now glows in its colour instead of showing a dot, on the avatar in the top bar and sidebar, the account switcher and the Accounts page. Every account keeps a thin ring in its colour, so you can still tell them apart.

### Security

- Removed the `zip` library that three critical path-traversal advisories flag (RUSTSEC-2026-0367, -0368, -0369). The updater only used it for Windows updates, which Winnow doesn't build, so no released app contained that code. Updates on macOS and the AppImage work as before.
- Updated tokio to 1.53.3 (RUSTSEC-2026-0386).

## [1.6.2] - 2026-10-25

A maintenance release. Winnow should look and behave exactly as it did in 1.6.1.

### Changed

- Moved the styling to Tailwind CSS v4. A 134-screen sweep across light, dark and Very dark themes showed no visual changes.
- Updated React to 19.3.1.

### Security

- Updated the test tooling to Vitest 5, which clears advisories in the old test runner (it never shipped inside the app).

## [1.6.1] - 2026-10-24

### Added

- About links to Winnow's source on GitHub.

### Changed

- Sender pictures are kept on the device, so avatars draw at once and offline, within tighter cache limits.
- Blur sensitive info moved to Settings → Privacy.
- Switching smart filters animates: the chips ease on and the list fades and slides in.
- The status pill fades out instead of blinking off.
- The debug log keeps 2,000 lines.

### Fixed

- In the smart filters sheet, the ticks and "Why it's here" scroll together.
- A beta install now sees the final release of the same version as newer: builds report their release tag.

## [1.6.0] - 2026-10-24

Everything from the 1.6.0 betas, for everyone on the stable channel.

### Added

- Offline mail that really saves: each account's mailbox, message bodies and attachments (up to 10 MB each) are kept on the device and download in the background, newest first. Settings → Notifications & sync shows how much is saved, with Remove downloads.
- When Gmail can't be reached, your cached inbox stays usable with a red "Failed to connect to Gmail" bar, and changes wait in the queue. Only real account problems still block.
- Blur sensitive info, in steps: email addresses, then passwords, postal addresses and names. Best effort.
- On a phone, the reader shows the open message's place in its mailbox (N of M), top right.
- Native builds check for updates on every tenth launch, if automatic checks are on.
- Dev Options, hidden until you tap About's version ten times: Pure Plain Text, View Original, Show filter scores, a redacted debug log, and on native builds Send test notification, Check now and Beta updates.

### Changed

- The attention line counts emails about deliveries and security.
- The desktop reader toolbar lines up with the top bar.

### Fixed

- Mail deleted in Gmail is now removed from Winnow too, and its notification is withdrawn.
- Pre-releases never reach the stable update channel.

## [1.6.0-beta.2] - 2026-10-24 (pre-release)

### Added

- When Gmail can't be reached, your cached inbox stays usable with a red "Failed to connect to Gmail" bar, and changes wait in the queue. Only real account problems (revoked access, a bad client) still block.
- Censor email addresses became Blur sensitive info, with levels: off, email addresses, then passwords, postal addresses and names.

### Changed

- The Accounts sheet is solid, and code boxes in the debug log and What's new use the app's rounded corners.

## [1.6.0-beta] - 2026-10-24 (pre-release)

### Added

- Offline mail that really saves: each account's mailbox, bodies and attachments are kept on the device and download in the background. Mail deleted in Gmail is deleted here too.
- Settings → Appearance → Censor email addresses.
- Dev Options (tap About's version ten times): Pure Plain Text, View Original, Show filter scores, Debug log, and on native builds Send test notification, Check now and Beta updates.
- Native builds check for updates on every tenth launch.

### Changed

- The attention line counts emails about deliveries and security.
- The desktop reader toolbar shares the top bar's centre line.

### Fixed

- Pre-releases never reach the stable update channel unless Beta updates is on.

## [1.5.5] - 2026-10-23

### Added

- On a phone, swipe the reader's action pill to step to the next or previous message.
- An update button beside the version (tap the logo): Check for updates, then Update. Native builds only.

### Changed

- Android notifications use Gmail's button order (Delete, Mark read, Reply) and show the sender's picture or monogram.

## [1.5.4] - 2026-10-23

### Fixed

- On a phone, sheets and menus opened from Settings sit above the dock.

### Security

- Every release carries `SHA256SUMS`, and the app checks a downloaded APK or `.deb` against it before opening the installer. A missing list or a mismatch is refused.

## [1.5.3] - 2026-10-23

### Added

- Swipe actions and long-press work with a stylus such as the S Pen.

## [1.5.2] - 2026-10-22

A small fix-up release for the Android phone layout.

### Changed

- Newsletters with wide padding fit the phone screen without splitting words: Winnow keeps whole words together and zooms the message to fit. On phones the email body uses the full width of the screen.
- The README has been rewritten.

### Fixed

- The account switcher is reachable again on Android phones: its menu no longer opens underneath the dock.

## [1.5.1] - 2026-10-22

A small fix-up release for Send later and Snooze.

### Fixed

- Editing or cancelling a scheduled message sent from another account now uses that account's draft and Drafts, instead of leaving a stray copy behind.
- Two Winnow windows no longer wipe each other's snoozes and scheduled messages.

## [1.5.0] - 2026-10-21

### Added

- Automatic updates: Winnow updates itself on macOS and the Linux AppImage, the `.deb` opens the installer, and Android downloads the new APK. What's new shows what changed in every version you skipped.
- A five-step tour over the demo inbox for first-time users (Settings → About → Show the tour again).
- An Accounts page: switch accounts, set each one's colour and notifications, sign out, add an account or open the demo inbox.
- Docker: `docker compose up -d` runs the web app and its proxy (`ghcr.io/hxmbl/winnow`, amd64 and arm64). Each start fetches the newest verified release, so restarting is the update.
- One-click unsubscribe in the reader when a newsletter offers it.
- A setting for the unread count on the Dock and app icon.
- Open the demo inbox from the account switcher.
- A Liquid Glass macOS icon, a new DMG background and a bigger menu bar icon.

### Changed

- The phone menu matches the desktop order, with Inbox at the bottom.

### Removed

- Windows builds. On Windows, use Docker or host the web app.

### Fixed

- The sign-in sheet closes once your first account is connected.
- The undo pill goes away on its own after 6 seconds.
- The unread badge clears at zero.
- Plain-text emails lose leftover filler characters.

## [1.4.0] - 2026-10-21

### Added

- Multiple Gmail accounts: an account switcher, a From picker, per-account settings, and notifications that open the right account's message.
- Snooze (a Snoozed mailbox; mail wakes to the top of the Inbox) and Send later (a Scheduled mailbox with Edit, Send now and Cancel).
- Email bodies follow the dark and Very dark themes, with a per-message toggle back to the original colours.
- Four more accents (Rose, Green, Blue, Graphite) and a custom colour, kept readable in every mode.
- Gmail-style Android notifications: sender, subject, preview.

### Changed

- Liquid Glass on the floating bars, and the accent only on buttons and other actions.
- OLED mode is called Very dark, and light mode is near white.
- Smart filter chip counts follow an active search and each other: a chip counts what tapping it would show.
- A lighter, smaller inbox-clear screen.

### Fixed

- SVG brand logos draw at full size in notifications.

## [1.3.5] - 2026-10-20

### Fixed

- Newsletters keep their own stylesheet, fenced to that one message, so their phone layout applies instead of a zoomed-down desktop table.

## [1.3.4] - 2026-10-20

Includes everything meant for 1.3.3, which was tagged but never released.

### Added

- Large attachments (over 25 MB) can go as Google Drive links. Winnow asks for Drive access the first time, never at sign-in, and only shares the files it uploaded (Settings → Privacy).
- New-mail notifications show the sender's picture on Android, Linux and Windows.

### Changed

- Smart filters apply to the open mailbox, and chips with nothing in them step back.
- Fixed-width HTML email is scaled to fit a phone.
- Multi-value settings are dropdowns, and Keyboard shortcuts appears on touch devices once a keyboard is used.
- "Why it's here" moved to the bottom of the email, next to Change smart filters.
- The phone chip rail lost its joining band, and dark chips are more vibrant.
- Inbox clear shows a single plane.
- No motion blur on the filter chips while scrolling.

### Fixed

- Drive links in a reopened draft are shared when the message actually goes out (after the undo window, or when the offline queue sends it). If Drive access is gone, Winnow asks first, and an abandoned send takes back only the sharing it added.
- Smart filter chips stay pills while held.

### Security

- Remote images set to Never also pauses Gravatar and brand-logo lookups.

## [1.3.3] - 2026-10-19 (not released)

Tagged, but its build was cancelled before release. Its changes shipped in 1.3.4.

## [1.3.2] - 2026-10-19

### Added

- A thumb-first phone layout: a compose top bar (Cancel with Delete Draft or Save Draft, Send top right), a floating reader pill that folds while you read, and confirmations before deleting forever and signing out.
- Settings → Appearance → Left-handed, which mirrors the reader pill and the compose button.

### Fixed

- The status pill no longer covers the demo strip's Connect Gmail.
- Phone chrome stays solid with forced colours, and a few colours were darkened for contrast.
- Compose suggestions show the name first.
- Keyboard shortcuts are a two-column grid, and Settings categories fit on one line.

## [1.3.1] - 2026-10-19

### Added

- Undo for every move: archive and trash on desktop, batch actions, the row menu and the reader, plus `z` / Ctrl+Z / ⌘Z.
- The demo offers "Back to your inbox" when you're signed in.

### Fixed

- The status pill could land over the top bar after leaving an account for the demo, notably on Android.
- Phone Settings has a solid backdrop, so the inbox no longer shows through as it opens.

## [1.3.0] - 2026-10-19

Everything from 1.3.0-beta, for everyone on the stable channel.

### Added

- Smart filters that learn from your corrections, with "Why it's here" in plain English. Learning stays on your device and can be reset in Settings.
- Undo send with a window you choose, and an offline queue that sends when you're back online.
- Attachments in the reader (image previews, open PDFs) and in compose (up to 25 MB).
- Notification actions: Reply, Delete and Mark read, and an option to hide previews on the lock screen.
- Optional native Google sign-in on Android; otherwise sign-in opens in a Custom Tab.
- A resumable, step-by-step Google setup guide.
- A calm inbox-clear screen.
- One status pill for action notices (Undo, sending, Draft saved) instead of separate strips.
- A new action bar at the top of the reader, and `[` opens and closes the sidebar.

### Changed

- The top bar floats over the list in frosted glass, the first email always clears it, and Home jumps to the top. Tap the logo to show the version.
- A correction moves only that sender's mail for that filter; a whole domain needs corrections from two or more addresses there.
- Opening, archiving and scrolling a big inbox do less work.
- Archived and deleted rows slide away, and menus pop open.

### Removed

- Labels (Label as, label chips and label mailboxes). Winnow no longer changes your account's labels.

## [1.3.0-beta] - 2026-10-18 (pre-release)

A pre-release for testing. Native Android Google sign-in and the notification actions had not been tested on real devices.

### Added

- A frosted floating top bar; tap the Winnow logo to show or hide the version.
- The top email always clears the bar, and the Home key jumps back to the top.
- Undo send with a window you choose in Settings, and an offline queue for mail sent offline.
- Label chips and label mailboxes, attachments in the reader (image previews, open PDFs) and attachments when composing (up to 25 MB).
- A resumable, step-by-step guide for connecting your own Google client.
- A calm screen when there's nothing left in your inbox.
- Optional native Google sign-in on Android, for self-built APKs; otherwise sign-in opens in a Custom Tab.
- Smart filters that learn from your corrections, with "Why it's here" in plain English.
- Reply, Delete and Mark read from a notification, and an option to hide previews on the lock screen.

## [1.2.2] - 2026-10-18

### Added

- Back to top on phones: a "Top" pill appears once you've scrolled more than a screen.
- Pull to refresh on phones, replacing the "Synced just now / Sync now" strip once an account is connected.

### Changed

- On desktop, the search bar and filter chips float over the mail list in frosted glass.
- Softer glass on every pill, which eases when it changes (and doesn't animate with reduced motion).
- Archive and Sent swapped places in the dock menu.

### Fixed

- Tapping Inbox in the expanded dock menu works again.

## [1.2.1] - 2026-10-18

### Added

- A floating dock on phones: Inbox and Sent on a frosted pill, with compose beside it. Expand grows it into the mailbox menu.
- Swipe actions: left to Trash (restore, in Trash), right to toggle read, each with Undo. Turn them off in Settings → Reading.
- Haptics on Android for swipes and long-press.

### Changed

- Each smart filter is its own floating glass pill.

### Fixed

- Android sign-in no longer fails with "Failed to fetch" after approving in Google, and the "Signed in" page has a Back to Winnow button.

## [1.2.0] - 2026-10-18

### Added

- A Drafts mailbox: Gmail drafts reopen in the composer and save as you type.
- Undo send after a delay you choose (Off, 5, 10, 20 or 30 seconds).
- Label as: add or remove Gmail labels, or create one.
- Android Back closes menus, sheets, the composer, the sidebar, Settings and the open message before leaving the app.
- A five-step Google setup walkthrough with links to each Cloud Console page.
- New light, dark and themed launcher icons, and a favicon that follows your system theme.

### Changed

- The phone dock is Inbox, Sent, Archive; Settings moved to the menu's account row, and the menu is reversed so Inbox sits nearest your thumb.
- Urgent is marked in its filter chip's colour.

### Removed

- Mark all read. Winnow marks a message read when you open it.

### Security

- The web build sets a strict Content-Security-Policy.

## [1.1.1] - 2026-10-17

### Changed

- The Android APK is release-signed. If you have an earlier `-debug` APK installed, uninstall it once before installing this one.

## [1.1.0] - 2026-10-17

### Added

- The Android app (Android 7+).
- Compose a new message, with Cc/Bcc and `mailto:` links; reply and forward dock inside the reader, Reply all by default, and drafts autosave to Gmail.
- Messages are marked read when opened (Settings → Reading).
- Settings is a full page with categories, controls and an explanation of each setting.
- Gravatar photos, off by default.
- Drag from a sender's avatar to select a range, and Select all from this sender.
- A resizable divider between the list and the reader.
- Import your Google client's JSON by file, drop or paste.

### Changed

- The Winnow logo replaces the sidebar icon, and the phone menu opens with a second tap on Inbox.
- Smart filters can no longer be hidden from the rail.

### Security

- Signing out revokes Winnow's access at Google and erases drafts, message bodies and late sync writes kept on the device.
- Remote images and emails are loaded without a Referer.
- Android app data is excluded from cloud backup and device transfer.

## [1.0.1] - 2026-10-15

### Changed

- Release builds start automatically when a version is tagged.

## [1.0.0] - 2026-10-15

The first release of Winnow rebuilt as a React and Tauri desktop app, with the web app as the product.

### Added

- A Gmail client that sorts the inbox into smart filters, with a sentence on what needs your attention.
- Bring your own Google OAuth client: Winnow ships none, and a setup sheet walks you through it. A demo mailbox works without one.
- Fast sync: the inbox first, message bodies on open, and polling while the window is focused.
- Sender pictures from Google contacts (opt-in) or brand logos (off by default), and recipient suggestions in compose.
- One-time codes detected on the device, with a copy chip on the row and a bar in the reader.
- Multi-select, a sender menu and a Gmail-style context menu.
- A phone layout, a floating sidebar over a soft blur, and light, dark and OLED themes with several accents.

[Unreleased]: https://github.com/hxmbl/winnow/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/hxmbl/winnow/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/hxmbl/winnow/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/hxmbl/winnow/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/hxmbl/winnow/compare/v1.5.5...v1.6.0
[1.6.0-beta.2]: https://github.com/hxmbl/winnow/compare/v1.6.0-beta...v1.6.0-beta.2
[1.6.0-beta]: https://github.com/hxmbl/winnow/compare/v1.5.5...v1.6.0-beta
[1.5.5]: https://github.com/hxmbl/winnow/compare/v1.5.4...v1.5.5
[1.5.4]: https://github.com/hxmbl/winnow/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/hxmbl/winnow/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/hxmbl/winnow/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/hxmbl/winnow/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/hxmbl/winnow/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/hxmbl/winnow/compare/v1.3.5...v1.4.0
[1.3.5]: https://github.com/hxmbl/winnow/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/hxmbl/winnow/compare/v1.3.2...v1.3.4
[1.3.3]: https://github.com/hxmbl/winnow/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/hxmbl/winnow/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/hxmbl/winnow/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/hxmbl/winnow/compare/v1.2.2...v1.3.0
[1.3.0-beta]: https://github.com/hxmbl/winnow/compare/v1.2.2...v1.3.0-beta
[1.2.2]: https://github.com/hxmbl/winnow/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/hxmbl/winnow/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/hxmbl/winnow/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/hxmbl/winnow/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/hxmbl/winnow/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/hxmbl/winnow/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hxmbl/winnow/releases/tag/v1.0.0
