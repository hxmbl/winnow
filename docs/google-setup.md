# Setting up your own Google client

Winnow doesn't ship a Google sign-in client. To connect Gmail you create one in
your own Google Cloud project and paste it into Winnow. It's free, takes about ten
minutes, and means your mail goes between your device and Google with nobody in
between.

You only need this to connect a real account. The demo mailbox works without it.

## 1. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in
   with the Google account you want to read mail from (any account works, but
   using the same one keeps things simple).
2. Use the project picker at the top and choose **New project**. Call it
   something like `Winnow`. No billing account is needed.

## 2. Enable the two APIs

In **APIs & Services → Library**, search for and **Enable** each of these:

- **Gmail API**, for your mail.
- **People API**, for the optional "Improve suggestions from Google contacts"
  feature. Winnow works without it, but enabling it now saves a trip back later.

## 3. Configure the OAuth consent screen

Open **Google Auth Platform** (older consoles call it **APIs & Services → OAuth
consent screen**).

1. **Branding / App information.** App name `Winnow` (or anything you like), and
   your own email as the support and developer contact.
2. **Audience.** Choose **External** and leave the publishing status on
   **Testing**. (If you have a Google Workspace account and only you will use it,
   **Internal** also works and avoids the 7-day limit below.)
3. **Test users.** Add the Gmail address you'll sign in with. In Testing mode only
   listed test users can sign in.
4. **Data access / Scopes.** Choose **Add or remove scopes** and add exactly these
   three. Paste them into the "Manually add scopes" box if they don't show up in the
   list:

   | Scope | When Winnow asks | What for |
   | --- | --- | --- |
   | `https://www.googleapis.com/auth/gmail.modify` | at sign-in | read, label, archive and send your mail |
   | `https://www.googleapis.com/auth/contacts.readonly` | only if you opt in, later | your saved contacts, in recipient suggestions (and their photos in sender avatars) |
   | `https://www.googleapis.com/auth/contacts.other.readonly` | only if you opt in, later | "other contacts" (people you've written to), in recipient suggestions |

   Sign-in asks for `gmail.modify` and nothing else. The two contact scopes are only
   requested when you choose **Improve suggestions from Google contacts** in
   Settings.

## 4. Create the client

Go to **Google Auth Platform → Clients** (or **APIs & Services → Credentials →
Create credentials → OAuth client ID**) and choose **Create client**. The type
depends on which Winnow you use.

### Desktop app (macOS, Windows, Linux)

1. **Application type: Desktop app.** Name it `Winnow desktop`.
2. Create it. There are no redirect URIs to add: the desktop app listens on a
   random local port (`http://127.0.0.1:<port>/winnow-oauth`), which Google allows
   for Desktop clients automatically.
3. Copy the **Client ID**, and the **Client secret** if one is shown.

The secret is optional in Winnow for a Desktop client. Google issues one, but for
an installed app it isn't treated as confidential, and Google's documentation lists
it as optional for this flow. If **Test connection** says the client needs it,
paste it in. It's stored in your operating system's keychain.

### Web application (running Winnow in a browser)

1. **Application type: Web application.** Name it `Winnow web`.
2. Under **Authorised JavaScript origins**, add the address you open Winnow at,
   without a trailing slash, for example `https://mail.example.com` or
   `http://localhost:5173`.
3. Under **Authorised redirect URIs**, add the same address **with** its path and
   trailing slash, for example `https://mail.example.com/` or
   `http://localhost:5173/`. Winnow's setup screen shows the exact value for the
   page you have open, with a copy button. It has to match character for character:
   `localhost` and `127.0.0.1` are different addresses to Google.
4. Create it, and copy both the **Client ID** and the **Client secret**. A Web
   application client needs the secret.

The secret is kept in that browser's local storage, for that site only, and sent
only to Google's token endpoint. Anyone who can run code on that page could read
it, so only run Winnow in the browser on a machine and origin you control. The
desktop app keeps it in the system keychain instead.

## 5. Import or paste it into Winnow

1. In Winnow, choose **Connect Gmail** (in the demo's status line or the menu), or
   open **Settings → Google account → Set up**.
2. Either import the client's JSON file, or paste the two values by hand:
   - **Import JSON.** On the client's page in Google Cloud, choose **Download
     JSON** (it saves `client_secret_<id>.json`). In Winnow, choose **Import
     JSON** and pick the file, drop the file anywhere on the setup sheet, or open
     the file in a text editor and paste all of its text into the **Client ID**
     field. Winnow fills in the client ID and secret, shows which Cloud project
     the client came from, and links straight to the Gmail API and People API
     pages for that project so you can check both are enabled.
   - **By hand.** Paste the **Client ID** (it ends in `.apps.googleusercontent.com`)
     and, if you have one, the **Client secret**.
3. Choose **Test connection**. Winnow asks Google whether it recognises the client,
   without signing you in. It points at the field to fix if something is wrong.
4. Choose **Save and connect**. Google's sign-in opens; pick the test user you
   added.

To change the client later, open **Settings → Google account → Change**. Saving a
different client signs you out, because Google won't refresh a session under a
different client. **Remove** forgets the client and signs you out.

### What Import JSON checks

- **The client type has to match the app.** The desktop app needs a **Desktop
  app** client: it signs in through `http://127.0.0.1:<port>/winnow-oauth` on a
  random port, which Google allows only for Desktop clients, so a Web
  application file is refused there. Winnow in the browser needs a **Web
  application** client, because Google returns to the page's own address, which a
  Desktop client can't register; a Desktop app file is refused there.
- **It has to be the client file.** A file that isn't JSON, is over 64 KB, has no
  `client_id`, has a `client_id` that doesn't end in `.apps.googleusercontent.com`,
  or is a service account key is refused with a sentence saying what to download
  instead. A web client file without a `client_secret` is refused too.
- **Warnings, not refusals.** For a web client, Winnow warns when the file doesn't
  list the redirect URI it shows (exactly, trailing slash included) or the page's
  origin. It also warns when the file's `auth_uri` or `token_uri` isn't one of
  Google's; Winnow always uses Google's own endpoints whatever the file says.
- **Nothing is saved until you choose Save and connect**, and then it is stored
  exactly as if you had typed it. The secret is never shown or logged.

## What to expect from Google

- **"Google hasn't verified this app."** Your project is unverified, so Google shows
  a warning screen before the consent screen. That's expected for a personal
  project: choose **Continue** (on some accounts it's under **Advanced**). You're the
  developer and the user here, and the app is your own client. Removing the warning
  means submitting your project for Google's verification, which a personal setup
  doesn't need.
- **Weekly sign-in in Testing mode.** For an **External** app left in **Testing**,
  Google issues refresh tokens that expire after 7 days (see "Refresh token
  expiration" in [Google's OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2#expiration)).
  Winnow will ask you to sign in again about once a week. Publishing the app
  ("In production") removes the 7-day limit, but Google then asks for verification
  of the Gmail and contacts scopes before strangers can use it; for yourself you can
  keep clicking through the warning. An **Internal** app (Workspace only) doesn't
  have the limit.
- **Revoking access.** You can disconnect Winnow at any time at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions), or
  delete the client or the whole project in Cloud Console.

## Troubleshooting

| What you see | Usual cause |
| --- | --- |
| "Google doesn't know this client ID" | Copied only part of the ID, or from another project. |
| "Google rejected the client secret" | Old or mistyped secret. Copy it again; you can add a new secret on the client's page. |
| `redirect_uri_mismatch` (web) | The redirect URI in Cloud Console doesn't exactly match the one Winnow shows. Check the scheme, host, port and trailing slash. |
| `access_denied` / "app is being tested" | The account you picked isn't listed under **Test users**. |
| "This is a Web application client, which the desktop app can't use" | You downloaded the JSON of a Web application client. Create a **Desktop app** client and import its JSON. |
| "This is a Desktop app client, which Winnow in the browser can't use" | Create a **Web application** client for the browser, or use the desktop app. |
| Contacts suggestions won't connect | The People API isn't enabled, or the two contact scopes aren't on the consent screen. |
| Signed out every week | Testing mode's 7-day refresh tokens, see above. |
