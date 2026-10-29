# Connecting Gmail: set up your own Google client

Winnow doesn't ship a Google sign-in client. To connect Gmail you make one in your
own Google Cloud project and paste it into Winnow. It's free, needs no billing
account, takes about ten minutes the first time, and means your mail goes between
your device and Google with nobody in between.

You only need this to connect a real account. Winnow always opens on the demo
mailbox, and the setup only appears when you ask for it: **Connect Gmail** (in the
demo's status line or the menu), **Continue with Google**, or **Settings → Google
account → Set up**.

Winnow's setup sheet walks you through the same five steps as this guide, with a
link to the right Google Cloud page on each one.

| Step | What you do | Google Cloud page |
| --- | --- | --- |
| 1 | Create a project | [New project](https://console.cloud.google.com/projectcreate) |
| 2 | Turn on the Gmail API (and the People and Drive APIs, optional) | [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) · [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) · [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) |
| 3 | Set up the consent screen and add yourself as a test user | [Consent screen](https://console.cloud.google.com/apis/credentials/consent) · [Test users](https://console.cloud.google.com/auth/audience) |
| 4 | Create the OAuth client | [Create client](https://console.cloud.google.com/apis/credentials/oauthclient) |
| 5 | Paste or import it into Winnow | Winnow's setup sheet |

The console opens each link in whichever project is selected at the top of the page,
so keep your new project selected throughout.

---

## Step 1. Create a project

1. Open [New project](https://console.cloud.google.com/projectcreate) and sign in
   with a Google account. Any account works; the one you'll read mail from keeps
   things simple.
2. Name the project `Winnow` and choose **Create**. No billing account is needed.
3. Check the project picker at the top of the console shows **Winnow**.

Already have a project you want to use? Select it in the project picker and go on.

## Step 2. Turn on the Gmail API

1. Open the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   page and choose **Enable**.
2. *Optional:* open the [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
   page and choose **Enable**. Winnow uses it only for contact photos and recipient
   suggestions, which you turn on later in **Settings → Google contacts**. Winnow
   works without it; enabling it now saves a trip back.
3. *Optional:* open the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   page and choose **Enable**. Winnow uses it only to send a file over Gmail's 25 MB
   as a Drive link: it uploads that file to your Drive, shares it with the recipients
   as viewers, and puts a "File name (size) — link" line in the message. It can only
   ever reach the files it uploaded itself. If you skip this, Winnow tells you with a
   **Turn on the Drive API** link the first time you try.

## Step 3. Set up the consent screen

Google shows a consent screen before it lets any app read mail. In the console it's
called **Google Auth Platform** (older consoles say **APIs & Services → OAuth
consent screen**). Open the [consent screen](https://console.cloud.google.com/apis/credentials/consent)
and choose **Get started** if it asks.

1. **App information.** App name `Winnow` (or anything you like), and your own email
   as the user support email.
2. **Audience.** Choose **External**. (With a Google Workspace account that only you
   will use, **Internal** works too and has no 7-day limit, below.)
3. **Contact information.** Your own email again. Agree to the policy and choose
   **Create**.
4. **Test users.** Open [Audience](https://console.cloud.google.com/auth/audience),
   leave the publishing status on **Testing**, and under **Test users** choose
   **Add users** and add the Gmail address you'll sign in with. While the app is in
   Testing, only listed test users can sign in.
5. *Optional:* under **Data access**, choose **Add or remove scopes** and add the
   scopes Winnow asks for. In Testing this isn't required, but it makes the consent
   screen list them:

   | Scope | When Winnow asks | What for |
   | --- | --- | --- |
   | `https://www.googleapis.com/auth/gmail.modify` | at sign-in | read, label, archive and send your mail |
   | `https://www.googleapis.com/auth/contacts.readonly` | only if you opt in, later | your saved contacts, in recipient suggestions (and their photos in sender avatars) |
   | `https://www.googleapis.com/auth/contacts.other.readonly` | only if you opt in, later | "other contacts" (people you've written to), in recipient suggestions |
   | `https://www.googleapis.com/auth/drive.file` | only if you opt in, later | only the files you send as Drive links (over 25 MB); nothing else in your Drive |

   Sign-in asks for `gmail.modify`, plus your basic profile for your own profile
   picture (requested at runtime, so there is nothing to add for it here), and nothing
   else. The two contact scopes are only
   requested when you choose **Improve suggestions from Google contacts** in Settings,
   and `drive.file` only the first time you choose **Send as a Drive link** for a file
   over 25 MB, after Winnow has said what it allows. **Settings → Privacy → Big files
   as Drive links** shows whether it is allowed and turns the offer off; signing out
   revokes it with everything else.

## Step 4. Create the OAuth client

Open [Create client](https://console.cloud.google.com/apis/credentials/oauthclient)
(or **Google Auth Platform → Clients → Create client**). The **Application type**
depends on which Winnow you use.

### Desktop app: macOS, Windows, Linux and Android

1. **Application type: Desktop app.** Name it `Winnow`.
2. Choose **Create**. There are no redirect URIs to add: the app signs in through a
   local address (`http://127.0.0.1:<port>/winnow-oauth` on a random port), which
   Google allows for Desktop app clients automatically.
3. Copy the **Client ID**, and the **Client secret** if one is shown, or choose
   **Download JSON**.

The secret is optional in Winnow for a Desktop app client. Google issues one, but
for an installed app it isn't treated as confidential. If **Test connection** says
the client needs it, paste it in. It's stored in your system's keychain.

### Web application: Winnow in a browser

1. **Application type: Web application.** Name it `Winnow web`.
2. Under **Authorised JavaScript origins**, add the address you open Winnow at,
   *without* a trailing slash, for example `https://mail.example.com` or
   `http://localhost:5173`.
3. Under **Authorised redirect URIs**, add the same address *with* its path and
   trailing slash, for example `https://mail.example.com/` or
   `http://localhost:5173/`. Winnow's step 4 shows both exact values for the page
   you have open, with copy buttons. They must match character for character:
   `localhost` and `127.0.0.1` are different addresses to Google.
4. Choose **Create**, and copy both the **Client ID** and the **Client secret**, or
   choose **Download JSON**. A Web application client needs the secret, and Google's
   secrets start with `GOCSPX-`. (A client made before 2022 may have an older-style
   secret: add a new one on the client's page.)

The secret is kept in that browser's local storage, for that site only, and sent
only to Google's token endpoint. Anyone who can run code on that page could read
it, so only run Winnow in the browser on a machine and address you control. The
desktop app keeps it in the system keychain instead.

## Step 5. Paste it into Winnow

On the setup sheet's last step, either import the client's JSON file or paste the
two values:

- **Import JSON.** Choose **Import JSON** and pick the `client_secret_<id>.json`
  file, drop the file anywhere on the setup sheet (at any step), or paste the
  file's whole text into the **Client ID** field. Winnow fills in both values,
  shows which Cloud project the client came from, and links to the Gmail API and
  People API pages for that project so you can check both are on.
- **By hand.** Paste the **Client ID** (it ends in `.apps.googleusercontent.com`)
  and the **Client secret** (required for a Web application client, optional for a
  Desktop app).

Then:

1. Choose **Test connection**. Winnow asks Google whether it recognises the client,
   without signing you in, and points at the field to fix if something is wrong.
2. Choose **Save and connect**. Google's sign-in opens; pick the test user you
   added in step 3.

To change the client later, open **Settings → Google account → Change**; the sheet
opens straight on the paste step (step 5; step 6 in the Android app, which has the
optional step below). Saving a different client signs you out, because Google
won't refresh a session under a different client. **Remove** forgets the client
and signs you out.

### What Import JSON checks

- **The client type has to match the app.** The desktop and Android apps need a
  **Desktop app** client, so a Web application file is refused there. Winnow in the
  browser needs a **Web application** client, so a Desktop app file is refused there.
- **It has to be the client file.** A file that isn't JSON, is over 64 KB, has no
  `client_id`, has a `client_id` that doesn't end in `.apps.googleusercontent.com`,
  or is a service account key is refused with a sentence saying what to download
  instead. A web client file without a well-formed `client_secret` is refused too.
- **Warnings, not refusals.** For a web client, Winnow warns when the file doesn't
  list the redirect URI it shows (exactly, trailing slash included) or the page's
  origin. It also warns when the file's `auth_uri` or `token_uri` isn't one of
  Google's; Winnow always uses Google's own endpoints whatever the file says.
- **Nothing is saved until you choose Save and connect**, and then it is stored
  exactly as if you had typed it. The secret is never shown or logged.

### Optional on Android: sign in without the browser

The Android app adds one optional step before the paste step. With it, Winnow signs
you in with Google's own account picker (Google Play services) instead of opening a
browser. Skip it and nothing changes: sign-in goes through the browser, in a Custom
Tab over the app. The step counts toward the guide's progress like the others, and a
half-finished setup resumes on it.

It needs two more clients in the **same** project:

1. An **Android** client: **Create client → Android**, with the package name
   (`app.winnow.android`) and the **SHA-1 certificate fingerprint** the step shows.
   Both are read from the app on your phone, so they are the ones Google checks.
2. A **Web application** client, with no origins or redirect URIs. Paste its client
   ID and secret into the step. Google issues the sign-in code to this client, and
   Winnow uses its secret to finish signing in and to stay signed in.

Winnow still needs the Desktop app client from step 4: whenever the account picker
can't be used (no Google Play services, Google refusing the app, no network) it
quietly signs in through the browser with that client instead. Closing the picker
cancels the sign-in.

**"The package name and fingerprint are already in use."** Google lets each package
name and signing certificate pair belong to one Cloud project in the world, and every
copy of the official APK carries the same certificate. If someone registered it first,
the console refuses yours. Either skip the step (the browser sign-in works the same),
or build Winnow yourself with your own keystore (`native/README.md`, "Android
signing"): your build has a certificate nobody else has, and the step shows its SHA-1.
A self-built APK can't update the official one, or the other way round, because
Android refuses an update signed with a different key.

## What to expect from Google

- **"Google hasn't verified this app."** Your project is unverified, so Google shows
  a warning before the consent screen. That's expected for a personal project:
  choose **Continue** (on some accounts it's under **Advanced**). You're both the
  developer and the user here.
- **Signing in again every week in Testing.** For an **External** app left in
  **Testing**, Google's refresh tokens expire after 7 days (see "Refresh token
  expiration" in [Google's OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2#expiration)),
  so Winnow asks you to sign in about once a week. Publishing the app ("In
  production") removes the limit, but Google then wants the Gmail scope verified
  before anyone but you can use it. An **Internal** app (Workspace only) has no limit.
- **Revoking access.** Disconnect Winnow at any time at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions), or
  delete the client or the whole project in Google Cloud.

## Troubleshooting

The setup sheet explains these for you: on the paste step, open **Google showed an error?**
and paste what Google's page said (or pick it from the list) to get the fix and a
link back to the step where it is made. A failed **Test connection** or sign-in
shows the same fix under it. If you stop part-way, the sheet remembers your step
on this device and picks up there next time; **Start over** clears it.

| What you see | Usual cause |
| --- | --- |
| "Google doesn't know this client ID" | Copied only part of the ID, or from another project. |
| "Google rejected the client secret" | Old or mistyped secret. Copy it again; you can add a new secret on the client's page. |
| "A client secret starts with GOCSPX-" (web) | The secret field holds something else, or an older-style secret. Copy it again, or add a new secret on the client's page. |
| `redirect_uri_mismatch` (web) | The redirect URI in Google Cloud doesn't exactly match the one Winnow shows in step 4. Check the scheme, host, port and trailing slash. |
| `access_denied` / "app is being tested" | The account you picked isn't listed under **Test users** (step 3). |
| "Gmail API has not been used in project …" | The Gmail API isn't enabled in the project the client belongs to (step 2). |
| "This is a Web application client, which the desktop app can't use" | You downloaded the JSON of a Web application client. Create a **Desktop app** client and import its JSON. |
| "This is a Desktop app client, which Winnow in the browser can't use" | Create a **Web application** client for the browser, or use the desktop app. |
| No contact photos / suggestions | Connect them in Settings → Google contacts. If it says the People API is off, enable it in the project your client lives in (step 2). |
| "The Google Drive API is turned off" when sending a big file as a link | Choose **Turn on the Drive API** (or enable it in step 2) in the project your client lives in, then try again. |
| Signed out every week | Testing mode's 7-day refresh tokens, see above. |
