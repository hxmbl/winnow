# Winnow Privacy Policy

**Effective date:** 13 October 2026
**Last updated:** 13 October 2026

Winnow is an email client for Gmail. It runs on your own computer, as a desktop
app (macOS, Windows, Linux) or in your web browser, and talks to Google directly.
This policy explains what Winnow does with your information, and in particular
with the Google user data it gets when you connect your Gmail account.

## The short version

- Your mail goes between **your device and Google**, and nowhere else. Winnow has
  no server of its own that receives, stores or reads your email, your contacts or
  your Google sign-in tokens.
- Everything Winnow keeps — a cache of your mail, the contacts it suggests, your
  settings and what it has learned about your sorting — is kept **on your
  device**.
- Nothing is sold, shared, used for advertising, or used to train AI or machine
  learning models. There are no analytics, tracking or crash reports.
- You can disconnect Winnow at any time at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## 1. Who is responsible for Winnow

Winnow is made by **Hxmbl**, an individual developer based in the United
Kingdom. Hxmbl is the data controller for the purposes of the UK General Data
Protection Regulation (UK GDPR) and the Data Protection Act 2018, to the extent
that Hxmbl decides how and why personal data is processed by Winnow.

Contact:

- Email: `<CONTACT_EMAIL>`
- GitHub: [github.com/hxmbl/winnow/issues](https://github.com/hxmbl/winnow/issues)
  — please don't put personal information or the contents of your mail in a
  GitHub issue, because issues can be read by other people. Use email for
  anything private.

Because Winnow runs entirely on your device, Hxmbl does not receive, see or hold
your email, contacts, account details or tokens. The only personal data Hxmbl
itself receives is what you choose to send when you contact us (see section 6).

## 2. The Google user data Winnow accesses

When you choose **Connect Gmail**, Google asks you to grant Winnow these
permissions ("scopes"). Winnow asks for nothing else, and you can use Winnow's
demo mailbox without connecting an account at all.

| Permission | Scope | What Winnow uses it for |
| --- | --- | --- |
| Read, compose and send email from your Gmail account | `https://www.googleapis.com/auth/gmail.modify` | Showing your mail (messages, headers, bodies, attachments, labels, drafts) so Winnow can display, search, sort and classify it; sending the replies and new messages you write; and carrying out the actions you choose — archive, star, mark read or unread, label, move to Trash and back. |
| See and download contacts saved in your Google account | `https://www.googleapis.com/auth/contacts.readonly` | Suggesting recipients as you type an address in the composer. |
| See and download "Other contacts" (people you have interacted with) | `https://www.googleapis.com/auth/contacts.other.readonly` | The same recipient suggestions, for people you have emailed but never saved as a contact. |

Winnow also reads your Gmail profile (your email address and mailbox history
position) through the Gmail API, to show which account is connected and to
fetch only what has changed since the last sync.

## 3. How Winnow uses that data

Winnow uses Google user data only to provide the email features you can see in
the app:

- displaying, searching and threading your mail;
- classifying and ranking it (for example "needs a reply", "security alert",
  "one-time code", "shipping") and showing you why;
- learning from what you star and filter, so its sorting matches yours — this
  learning is a set of numbers stored on your device and is never sent anywhere;
- composing, replying to and sending mail, and suggesting recipients;
- desktop notifications and an unread badge for new mail, and syncing in the
  background on the desktop app while its window is hidden;
- saving an attachment to a place on your computer that you choose.

All of this happens in the app on your device. No person reads your data, and
Winnow does not use it for any other purpose.

**Limited Use.** Winnow's use and transfer to any other app of information
received from Google APIs will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## 4. Where your data is stored and who it travels to

**On your device.**

| What | Desktop app | Web version |
| --- | --- | --- |
| Google sign-in tokens (access and refresh tokens) | Your operating system's credential store: macOS Keychain, Windows Credential Manager, or Secret Service on Linux | Your browser's local storage for the site |
| Cached copy of your mail (messages, bodies, labels, recipients) and the sync position | The app's local storage, in its data folder on your computer | Your browser's local storage for the site |
| Recipient suggestions | Built on your device from your mail and, where granted, your Google contacts | Same |
| Settings, filters, muted categories, blocked senders, learned sorting weights | The app's local storage | Your browser's local storage |
| A one-time sign-in code verifier (only during sign-in) | In memory | The browser tab's session storage, deleted when sign-in finishes |

Winnow does not add its own encryption to the mail cache; it is protected by your
operating system account and any disk encryption you use (such as FileVault,
BitLocker or LUKS). Anyone who can use your computer while you are signed in to it
may be able to read it.

**Network connections Winnow makes.** All of them use HTTPS.

- **Google** — `accounts.google.com` and `oauth2.googleapis.com` to sign in and
  refresh your session; `gmail.googleapis.com` / `www.googleapis.com` and
  `people.googleapis.com` for your mail and contacts. Google's own
  [privacy policy](https://policies.google.com/privacy) covers what Google does.
- **The servers of people who email you, only if you allow it.** Remote images in
  an email are blocked by default. If you choose to load images for a message,
  your device fetches them from wherever the sender put them, which tells that
  server your IP address and that the message was opened — as any email client
  would. This is decided one message at a time.
- **The render proxy, only in builds configured to use one.** Winnow's source
  includes an optional "render proxy" that fetches a message's images on your
  behalf so senders cannot see your IP address. The downloadable releases are
  **not** configured to use one, so they never contact it. If you build or use a
  copy of Winnow that is configured with a proxy and choose the "Proxied" view,
  the proxy receives that message's HTML body, fetches the images it refers to,
  and keeps the images (not the message) in memory for up to fifteen minutes. It
  does not log requests or store message contents. Whoever runs that proxy is
  responsible for it.
- **GitHub**, when you download Winnow from the Releases page. GitHub's
  [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  applies to that download.

Winnow has no analytics, telemetry, advertising or crash-reporting services.

## 5. Sharing

Hxmbl does not receive your Google user data, and Winnow does not share it with
anyone. In particular, Winnow does not:

- sell your data, or transfer it to advertising platforms, data brokers or
  information resellers;
- use your data to serve advertising, including personalised or interest-based
  advertising;
- use your data to determine creditworthiness or for lending;
- use your data to create, train or improve any artificial intelligence or machine
  learning model (Winnow's sorting rules and the weights it learns from you stay
  on your device and serve only you).

The only time your data leaves your device is when Winnow sends it to Google to do
what you asked (for example, sending an email), or when you choose to load a
message's images (section 4).

If Winnow were ever to change hands, your data would still not be transferred,
because Hxmbl does not hold it.

## 6. Contacting us

If you email us or open a GitHub issue, we receive what you send: your name or
username, your email address, and the content of your message. We use it only to
reply and to fix the problem you reported, keep it for as long as needed to deal
with it — normally no longer than 24 months after our last exchange — and do not
use it for marketing. GitHub issues are stored by GitHub, Inc. in the United
States under GitHub's own privacy statement.

## 7. Lawful basis (UK GDPR)

- **Running Winnow on your device for you** — reading, caching, sorting and
  sending your mail and suggesting recipients — is processing you ask for in order
  to use the app: performance of a contract with you (Article 6(1)(b)), the
  contract being the use of the app on these terms. You can stop at any time by
  signing out or revoking access.
- **Replying to you when you contact us** — our legitimate interest in supporting
  Winnow and responding to you (Article 6(1)(f)).

Your mail inevitably contains information about other people — the people who
write to you and whom you write to. Winnow processes it only on your device, only
to show you your own mail, and never shares it.

## 8. How long data is kept

- **On your device:** until you remove it. **Signing out** of Winnow deletes your
  Google tokens and the cached copy of your mail from the device. Your settings,
  filters and learned sorting weights stay until you clear the app's data or
  uninstall it (desktop), or clear the site's data in your browser (web). Winnow
  keeps no copy anywhere else, so there is nothing left for Hxmbl to delete.
- **At Google:** your mail and contacts remain in your Google account under
  Google's own policies; Winnow's actions (such as archiving or sending) change
  them there just as Gmail's own app would.
- **Correspondence with us:** as in section 6.

## 9. International transfers

Winnow does not transfer your personal data to Hxmbl or to any other country. Your
device exchanges data with Google, which may process it in data centres outside
the United Kingdom under Google's own terms. If you contact us on GitHub, that
message is held by GitHub, Inc. in the United States.

## 10. Security

- Sign-in uses Google's OAuth 2.0 with PKCE. Your Google password never passes
  through Winnow.
- The desktop app signs in through your system browser and a one-time listener on
  your own machine (`127.0.0.1`), ships no client secret, and keeps tokens in the
  operating system's credential store rather than in app files.
- Every connection to Google uses HTTPS.
- Email content is sanitised and shown in a sandbox, and remote images are blocked
  until you allow them.
- There is no Winnow server holding user data, so there is no central store to be
  breached.

No software is perfectly secure. If you find a security problem, please report it
privately to `<CONTACT_EMAIL>` rather than in a public issue.

## 11. Your rights

Under UK data protection law you have the right to:

- be informed about how your data is used (this policy);
- access the personal data held about you;
- have inaccurate data corrected;
- have your data erased;
- restrict or object to processing;
- data portability; and
- withdraw consent at any time, where processing is based on consent.

Because your mail and contacts are held on your device and in your Google
account, not by Hxmbl, you can exercise most of these rights directly: view
everything in the app or in Gmail, delete it by signing out or uninstalling, and
export it with [Google Takeout](https://takeout.google.com). For anything else —
including the data we hold if you have contacted us — write to `<CONTACT_EMAIL>`.
We will respond within one month.

## 12. Revoking Winnow's access

1. Go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
   (Google Account → Security → Your connections to third-party apps & services).
2. Choose **Winnow** and remove its access.

Winnow can then no longer read or change anything in your Google account. To also
remove what is stored on your device, sign out of Winnow before revoking access,
then uninstall the app (or, for the web version, clear the site's data in your
browser). On the desktop, the tokens are stored in your credential store under the
name `app.winnow.desktop` and can be removed there too.

## 13. Complaints

If you are unhappy with how your data has been handled, please contact us first at
`<CONTACT_EMAIL>` and we will try to put it right. We will acknowledge a complaint
within 30 days.

You also have the right to complain to the UK's data protection regulator, the
**Information Commissioner's Office (ICO)**, at
[ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/). If you live
elsewhere, you may be able to complain to your local data protection authority.

## 14. Children

Winnow is a general email client and is not directed at children. It is not
intended for anyone under 13, and it requires a Google account, which Google
itself restricts by age. Hxmbl does not knowingly collect personal data from
children; Winnow does not send any data to Hxmbl at all.

## 15. Changes to this policy

If this policy changes, the new version will be published here with a new
effective date, and the change will be noted in the release notes of the Winnow
version it applies to. The history of every change is visible in this file's
commit history. If Winnow ever starts to use Google user data in a new way or for
a new purpose, it will ask for your consent in the app before doing so.
