/**
 * What Settings contains: its categories, the settings in each, and the plain-English
 * explanation of every one.
 *
 * The explanation lives here, beside the definition, rather than in the component, so
 * a setting cannot be added without its copy: `SettingsPanel.tsx` renders rows by id
 * from this table, the type of `SETTINGS` requires an `explanation`, and
 * `settingsCatalog.test.ts` fails if one is empty, too long, or never rendered.
 *
 * Copy rules: two to four sentences, what it does, the trade-off, and what leaves the
 * device (if anything). Plain English, no marketing, no promises the code does not keep.
 */

export type CategoryId =
  | "reading"
  | "filters"
  | "compose"
  | "appearance"
  | "privacy"
  | "sync"
  | "google"
  | "senders"
  | "shortcuts"
  | "about"
  | "dev";

export type SettingsCategory = {
  id: CategoryId;
  label: string;
  /** What the explanation panel says before anything in the category is pointed at. */
  intro: string;
};

/** In the order the category list shows them. */
export const CATEGORIES: readonly SettingsCategory[] = [
  {
    id: "reading",
    label: "Reading",
    intro:
      "How your mail is ordered and what happens when you open it. Winnow learns from what you star and hide, and you can see or undo what it has learned here.",
  },
  {
    id: "filters",
    label: "Smart filters",
    intro:
      "Winnow sorts your inbox into smart filters with built-in rules. When it gets one wrong, use “Change smart filters…” on the message, and Winnow learns from that correction, here on this device. This is what it has learnt, and how to take it back.",
  },
  {
    id: "compose",
    label: "Compose",
    intro:
      "What happens when you write and send. Drafts are saved as you type, on this device at once and to Gmail's Drafts a moment later, so a closed window loses nothing.",
  },
  {
    id: "appearance",
    label: "Appearance",
    intro:
      "Light, dark or true black, and the one accent colour Winnow uses. These only change how Winnow looks on this device.",
  },
  {
    id: "privacy",
    label: "Privacy",
    intro:
      "What Winnow fetches from outside your mailbox. Each of these can tell someone else that you read or received mail, so each one is your choice, and the two picture sources are off until you turn them on. Signing out erases your mail and sign-in from this device and also asks Google to revoke Winnow's access, so no copy of that sign-in keeps working.",
  },
  {
    id: "sync",
    label: "Notifications & sync",
    intro:
      "When Winnow tells you about new mail, and how often it checks. Checking more often means more requests to Google, nothing else.",
  },
  {
    id: "google",
    label: "Google account",
    intro:
      "Winnow talks to Gmail through a Google client you create in your own Google Cloud project; it ships none of its own. Every account you add signs in with that same client. Your mail goes between this device and Google only.",
  },
  {
    id: "senders",
    label: "Hidden & muted senders",
    intro:
      "Senders you have hidden or muted from the sender menu. Hidden mail is kept out of Winnow; muted mail stays in your inbox but never interrupts you.",
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    intro:
      "Every key Winnow answers to. This list is built from the same table the keyboard uses, so it is always the real set. Press ? anywhere for the short version.",
  },
  {
    id: "about",
    label: "About",
    intro: "Which Winnow this is, and the terms it comes under.",
  },
  {
    id: "dev",
    label: "Dev Options",
    intro:
      "Switches for seeing exactly what a message carries, for testing and curiosity. They change only how Winnow shows mail on this device, never the mail itself, and are all off until you turn them on.",
  },
];

export type SettingDefinition = {
  category: CategoryId;
  /** The row's name, as the row and the explanation panel both show it. */
  label: string;
  explanation: string;
};

/**
 * Every setting, by id. `satisfies` keeps the ids literal (so `SettingId` is a closed
 * union and a row cannot name one that does not exist) while checking every entry has
 * its category, label and explanation.
 */
export const SETTINGS = {
  filterLearning: {
    category: "filters",
    label: "What's been learnt",
    explanation:
      "Every time you move a message with “Change smart filters…”, Winnow keeps that correction. One correction teaches a rule for that exact sender; a rule for a whole domain needs corrections from two of its addresses, all the same way, and never covers your own domain, a domain where you've written to three or more people (your workplace, say), or shared ones like gmail.com. Similar mail is judged by specific clues such as tracking and order numbers, and only after two similar corrections. Remove any sender rule here; it is all stored on this device only, never synced, and erased when you sign out or switch account.",
  },
  resetFilterLearning: {
    category: "filters",
    label: "Reset what's learnt",
    explanation:
      "Forgets every correction and sender rule for every smart filter, so they go back to Winnow's built-in rules. It asks first. To reset only one filter, use Reset beside it above.",
  },
  sortBy: {
    category: "reading",
    label: "Sort messages by",
    explanation:
      "Date shows the newest mail first, Sender groups mail by who sent it, and Smart Score puts what Winnow thinks matters most at the top. Smart Score is worked out on this device from what you star and hide; nothing is sent anywhere to rank your mail.",
  },
  markReadOnOpen: {
    category: "reading",
    label: "Mark as read when opened",
    explanation:
      "Opening a message or conversation marks it read in Gmail, so it also shows as read on your other devices. Turn this off if you use unread as a to-do list: mail then stays unread until you mark it yourself.",
  },
  swipeActions: {
    category: "reading",
    label: "Swipe actions",
    explanation:
      "On a phone, swipe a message left to move it to the Trash, with Undo, or right to mark it read or unread. In Drafts a left swipe discards the draft, and in the Trash it restores the message to the Inbox. The same actions stay in the selection bar and the message's own menu, so turning this off only takes away the gesture.",
  },
  undoSend: {
    category: "compose",
    label: "Undo send window",
    explanation:
      "After you press Send, the message waits this long with an Undo button before it goes, and Undo brings it back to the composer as it was. Nothing is recalled: the message simply has not left yet. If Winnow closes during the wait, the message is not sent but kept as a draft, in Gmail and on this device, and offered back next time. Off sends at once.",
  },
  sendLater: {
    category: "compose",
    label: "Send later and snooze",
    explanation:
      "Gmail does not let other apps schedule a send or snooze mail, so Winnow keeps the time on this device: a scheduled message waits in Gmail's Drafts, and snoozed mail is archived with the label Winnow/Snoozed. Winnow has to be open to send or bring them back at that time; if it is closed, they happen the next time you open it, and the status pill says the message went late. Opening Winnow on another device does not send them or bring them back, and signing out forgets the times (the drafts and the label stay in Gmail).",
  },
  resetSorting: {
    category: "reading",
    label: "Reset sorting",
    explanation:
      "Winnow adjusts its sorting each time you star a message or hide a bucket. Reset forgets those adjustments and goes back to the default sorting; it asks first, and the record of what happened is kept. Nothing about this leaves your device.",
  },
  learningHistory: {
    category: "reading",
    label: "What Winnow has learned",
    explanation:
      "A list of the stars and hides Winnow has learned from, newest first, with what it predicted at the time. It is there so you can check why mail is sorted the way it is. The list is stored on this device only.",
  },
  themeMode: {
    category: "appearance",
    label: "Mode",
    explanation:
      "System follows your device between light and dark. Very dark is dark on true black, which saves power on OLED screens but makes edges harder to see. This is saved on this device only.",
  },
  accent: {
    category: "appearance",
    label: "Accent",
    explanation:
      "The colour of Winnow's buttons, links, switches and unread marks; everything else stays neutral grey and white. Pick one of eight, now including Rose, Green, Blue and Graphite, or Custom for any colour you like. Every accent is checked for contrast in each mode, and a custom colour is lightened or darkened a little where it needs to be, so text on it stays readable.",
  },
  emailDarkMode: {
    category: "appearance",
    label: "Email dark mode",
    explanation:
      "In Dark and Very dark, messages are drawn dark too instead of as a white page: a message with its own dark design gets it, and any other has its colours adjusted so text stays readable, with images left as they are. The sun button above a message shows its original colours. Off keeps every message on its own light page. Light mode is unaffected.",
  },
  leftHanded: {
    category: "appearance",
    label: "Left-handed",
    explanation:
      "On a phone, puts the controls you reach with your thumb on the left: the message actions pill, the compose button and the order of the dock. Off keeps them on the right. Saved on this device.",
  },
  censorLevel: {
    category: "privacy",
    label: "Blur sensitive info",
    explanation:
      "For screenshots and sharing your screen: choose email addresses, then add passwords given in mail, postal addresses and the names of people Winnow knows, each step including the ones before. Everything hidden, in the list, the reader, the composer, Settings and notifications, becomes the same number of random letters and is blurred. It's best effort, not a guarantee: a password without a label, an unusual address or a name Winnow hasn't seen can get through, so check before you share. Mail you send is not affected: replies still go to the real addresses.",
  },
  remoteImages: {
    category: "privacy",
    label: "Remote images",
    explanation:
      "Images in mail are often tracking pixels: loading one tells the sender you opened the message, when, and roughly where from your IP address. Ask each time shows a button on each message; Always loads them without asking; Never keeps them blocked, and also pauses Sender pictures (Gravatar and brand logos), in the app and in notifications; contact photos and initials still show. Messages with images allowed are shown in a sandbox that runs none of the sender's code.",
  },
  senderPictures: {
    category: "privacy",
    label: "Sender pictures",
    explanation:
      "Shows a sender's Gravatar picture when they are not in your contacts, and a company's logo from the one it publishes for email (BIMI). For every sender in your list, opened or not, Winnow sends Gravatar a hashed copy of the address (a hash of a common address can be guessed, so Gravatar can still learn who mails you) and looks up the sender's domain with Cloudflare's DNS-over-HTTPS resolver, then loads any logo from the sender's own site. Off by default for that reason, and paused while Remote images is set to Never; logos are not certificate-verified. Contact photos and initials always show.",
  },
  driveLinks: {
    category: "privacy",
    label: "Big files as Drive links",
    explanation:
      "For a file over Gmail's 25 MB, the composer offers to upload it to your Google Drive and send a link, shared with the recipients so they can view it. Winnow asks Google for this the first time you use it, never at sign-in, and only for the files it uploads itself: it cannot see anything else in your Drive. Stop turns the offer off on this device; signing out, or removing Winnow at Google's account page, takes the permission back.",
  },
  notifications: {
    category: "sync",
    label: "Notify me about new mail",
    explanation:
      "Shows a system notification for each message that arrived in your inbox since the last sync, up to five at once with a summary for the rest. Never for older mail, mail already read, or senders you have muted or hidden. Your device asks for permission the first time; if you decline, this switches itself back off.",
  },
  notificationActions: {
    category: "sync",
    label: "Notification buttons",
    explanation:
      "Which buttons a new-mail notification offers. Reply sends from the notification on Android, and opens the composer on a computer; Delete moves the message to the Trash, never deletes it for good; Mark read marks it read in Gmail. On a Mac, and in the browser, a notification has no buttons and opens the message instead.",
  },
  notificationPrivacy: {
    category: "sync",
    label: "Hide preview on lock screen",
    explanation:
      "On, a notification on a locked phone says only that Winnow has new mail, not who sent it or what it says; unlock to see the rest. A computer has no separate lock-screen version, so there it shows the sender and \"New message\" instead of the subject. Nothing about this leaves the device.",
  },
  unreadBadge: {
    category: "sync",
    label: "Unread count on the app icon",
    explanation:
      "Shows how many unread messages are waiting: a badge on the Dock icon on a Mac, in the tray icon's tooltip on Linux, and in the tab's title in a browser. Mail from muted senders is never counted, and with nothing unread there is no badge at all. Off hides the count everywhere; your mail is unaffected.",
  },
  backgroundSync: {
    category: "sync",
    label: "Keep syncing while closed",
    explanation:
      "Keeps Winnow checking for new mail after you close it, so notifications still arrive. On a computer it stays in the system tray and checks on a timer. On Android it keeps a small, silent notification and checks Gmail every 5 minutes (sooner with \"Instant mail via the Gmail app\"), even after you swipe it away or restart the phone; it needs notifications on, since that is all it does with the app closed. Off, Winnow only syncs while it is open, which uses less battery and fewer requests to Google.",
  },
  gmailListener: {
    category: "sync",
    label: "Instant mail via the Gmail app",
    explanation:
      "Google tells the Gmail app about new mail the moment it arrives; with this on, Winnow notices the Gmail app's notification, checks for new mail straight away and shows its own notification in place of Gmail's. It only works with the Gmail app installed and signed in to the same accounts, with the Gmail app's notifications allowed, and Gmail's notification is only taken down once Winnow's is showing. Winnow looks only at the Gmail app's notifications, reads just the account they are for, and keeps nothing. Winnow also checks every 10 minutes as a backup, or every 5 without this.",
  },
  gmailListenerAccess: {
    category: "sync",
    label: "Notification access",
    explanation:
      "Android lets an app see notifications only after you allow Notification access for it, because that access could read any app's notifications. Winnow uses it for the Gmail app's notifications only and ignores every other app's. Google Play is strict about this kind of access, which is fine for Winnow because it is installed from GitHub rather than Google Play. You can take access away at any time in Android's settings, and instant mail stops.",
  },
  batteryUnrestricted: {
    category: "sync",
    label: "Run in the background",
    explanation:
      "Android pauses apps' network access when the phone sits idle (Doze) and some phones close background apps to save battery. Letting Winnow run without battery restrictions keeps background sync on time; without it, new mail can arrive late while the phone is idle. Android asks you to confirm, and you can change it later in system settings.",
  },
  syncNotification: {
    category: "sync",
    label: "Background sync notification",
    explanation:
      "Android requires a notification while an app keeps working with its window closed. Winnow's is silent and sits at the bottom of the shade. You can hide it in Android's settings for that one notification; background sync carries on, and new-mail notifications are not affected.",
  },
  syncInterval: {
    category: "sync",
    label: "Check every",
    explanation:
      "How often background sync asks Gmail for new mail while the window is closed. More often means quicker notifications but more requests to Google and a little more battery. While a window is open Winnow checks more often regardless.",
  },
  offlineMail: {
    category: "sync",
    label: "Save mail offline",
    explanation:
      "Keeps this account's mail on this device so it opens without a connection: everything Winnow has synced (your whole inbox, and the newest 500 of each other mailbox), with attachments up to 10 MB each, while bigger ones download when you open them. It downloads in the background, newest first, never ahead of the message you open, and waits while you are offline, on mobile data or Data Saver, on a low battery, or in the background on a phone. This is the same choice as the large-mailbox question, and mail deleted in Gmail is deleted here too. Signing out of the account erases all of it.",
  },
  removeDownloads: {
    category: "sync",
    label: "Remove downloads",
    explanation:
      "Deletes the message bodies and attachments saved on this device for this account and turns Save mail offline off. The list of your mail stays, and anything you open is downloaded again as you open it.",
  },
  oauthClient: {
    category: "google",
    label: "Your Google OAuth client",
    explanation:
      "The client ID (and secret, if it has one) from your own Google Cloud project that Winnow signs in with. On desktop it is kept in your system keychain; in the browser it is kept in this browser's storage. Change replaces or removes it; your mail itself never passes through anyone but Google.",
  },
  accounts: {
    category: "google",
    label: "Accounts",
    explanation:
      "Up to five Gmail accounts, each signed in on its own with your one Google client, managed on the Accounts page. Each account's mail, drafts, learning and sign-in are kept apart on this device, and switching never clears any of them. Signing out of one erases only that account from this device and asks Google to revoke its access; Sign out of all does that for every account.",
  },
  accountColor: {
    category: "google",
    label: "Colour",
    explanation:
      "A small coloured dot beside an account wherever Winnow shows it: the switcher, the avatar in the top bar and the Accounts page. It only helps tell accounts apart at a glance and is stored on this device.",
  },
  accountNotify: {
    category: "google",
    label: "Notify when not open",
    explanation:
      "Whether new mail in this account notifies you while you are reading another one. Winnow checks the accounts you are not viewing lightly, for their unread count and new mail only, on the same schedule as background sync. The open account always follows Notify about new mail.",
  },
  googleContacts: {
    category: "google",
    label: "Contact photos and suggestions",
    explanation:
      "An extra, read-only permission to your Google contacts, asked for only when you press Connect. It shows your contacts' photos beside their mail and suggests them as recipients. It needs the People API turned on in your Cloud project; Winnow says so if it is off.",
  },
  hiddenSenders: {
    category: "senders",
    label: "Hidden senders",
    explanation:
      "Mail from these senders is kept out of every Winnow list. It is not deleted and stays in Gmail, so Unhide brings it straight back. The list is stored on this device.",
  },
  mutedSenders: {
    category: "senders",
    label: "Muted senders",
    explanation:
      "Mail from these senders stays in your inbox, but never notifies you and is not counted on the unread badge. Unmute puts them back to normal. The list is stored on this device.",
  },
  shortcutList: {
    category: "shortcuts",
    label: "Shortcuts",
    explanation:
      "The keys Winnow answers to while you are not typing in a field. They cannot be changed yet. The list is generated from the keyboard handler itself, so it cannot fall out of date.",
  },
  version: {
    category: "about",
    label: "Version",
    explanation:
      "The version of Winnow you are running and where it is running. New desktop and Android builds are published on the project's Releases page on GitHub.",
  },
  updates: {
    category: "about",
    label: "Updates",
    explanation:
      "Winnow asks GitHub for its latest release when it starts and then every few hours, and tells you once when a newer one is out. The Mac app and the AppImage update themselves and restart; the .deb and Android download the new package for your installer; a self-hosted web copy needs a git pull, and the Docker image updates when its container restarts. The check sends nothing about you or your mail.",
  },
  tour: {
    category: "about",
    label: "The tour",
    explanation:
      "A short walk round Winnow: where your mailboxes are, how to read a message, what smart filters do and where the menu is. It opens by itself once, the first time Winnow starts on a device, and this plays it again. Watching it changes nothing.",
  },
  exportSettings: {
    category: "about",
    label: "Export settings",
    explanation:
      "Saves how Winnow is set up here to a small file you can keep, share or import on another device: appearance, reading and compose choices, privacy switches, notifications and sync, the update switch, the reader's width and Dev Options. It never includes your sign-in, Google client, accounts, mail, contacts, hidden or muted senders, or anything Winnow has learnt from you. The file is plain text, so you can open it and check.",
  },
  importSettings: {
    category: "about",
    label: "Import settings",
    explanation:
      "Reads a file made by Export settings and shows what it would change before anything does. Only settings Winnow knows are taken; anything else in the file is ignored, and a file from a newer Winnow is refused. Your accounts, mail and what Winnow has learnt are never touched.",
  },
  source: {
    category: "about",
    label: "Source code",
    explanation:
      "Winnow's code, releases and issue tracker live on GitHub. Open it to read the source, download a build or report a problem.",
  },
  licence: {
    category: "about",
    label: "Licence",
    explanation:
      "Winnow is open-source software under the MIT licence. You can use, change and share it freely; it comes with no warranty.",
  },
  purePlainText: {
    category: "dev",
    label: "Pure Plain Text",
    explanation:
      "When a message is shown as Plain text, shows its plain-text part exactly as the sender wrote it, with nothing removed: invisible preheader filler, blank lines and leading or trailing space all stay. A message with no plain-text part has its HTML turned into text as literally as possible, including the page title and style code Winnow normally leaves out. It is still shown as text, so nothing in it can run or load. Saved on this device only.",
  },
  viewOriginal: {
    category: "dev",
    label: "View Original",
    explanation:
      "Adds View Original to a message's ⋯ menu: the message exactly as Gmail stores it, every header and every MIME part, fetched from Gmail when you ask and shown as plain characters with a Copy button. Nothing in it is rendered, so no HTML, image or script in the message can run or load. It is not saved anywhere; in the demo the source is built on this device.",
  },
  filterScores: {
    category: "dev",
    label: "Show filter scores",
    explanation:
      "Adds the numbers behind each line of “Why it's here”: the built-in answer, the importance score or spam likelihood, which path decided, any sender rule and how many decisions made it, and the similar-mail naive Bayes working (each shared clue's weight, the total log-odds and the probability). They are worked out on this device from what is already there. Off, Why it's here is words only, as normal.",
  },
  testNotification: {
    category: "dev",
    label: "Test notification",
    explanation:
      "Posts a sample new-mail notification the way real mail does, with its picture and the Delete, Mark read and Reply buttons, so you can see how it looks on this device. It is not a real message: pressing its buttons changes nothing in your mailbox, and Winnow says so. Only on the installed app.",
  },
  devCheckNow: {
    category: "dev",
    label: "Check for updates",
    explanation:
      "Checks for a newer release now, the same check as Check now in About: it ignores the schedule and the automatic-check switch, and starts the every-tenth-load count again. The answer shows here: Update available, No updates available, or Couldn't check. It never installs anything; updating stays in About and the version's button. Only on the installed app.",
  },
  betaUpdates: {
    category: "dev",
    label: "Beta updates",
    explanation:
      "Also offers pre-releases (versions like 1.6.0-beta.1) when Winnow checks for updates, and installs them from that release's own files with the same signature and checksum checks. Betas can be rough, so this is off unless you turn it on. Turning it off never moves you back to an older version: you stay on the beta until the next stable release newer than it. Only on the installed app.",
  },
  debugLog: {
    category: "dev",
    label: "Debug log",
    explanation:
      "While on, Winnow keeps a log here of sign-in steps, sync, network errors, update checks, notifications and the app going to the background and back: what happened, ids, counts and how long it took. On the installed app it includes the app's native side too, such as the sign-in listener. It is kept in memory only, at most 10,000 lines, and is gone when Winnow closes; nothing is recorded while it is off. Email addresses, tokens, sign-in codes and anything from a message's content are removed before a line is kept, and Copy and Clear are the only ways it leaves this screen.",
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingId = keyof typeof SETTINGS;

export const SETTING_IDS = Object.keys(SETTINGS) as SettingId[];

export function categoryOf(id: CategoryId): SettingsCategory {
  return CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[0];
}

export function settingsIn(category: CategoryId): SettingId[] {
  return SETTING_IDS.filter((id) => SETTINGS[id].category === category);
}
