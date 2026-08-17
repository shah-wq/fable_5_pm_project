# Publishing the customer app to the App Store and Play Store

Everything in this file is the part of the mobile spec (§7, §8) that cannot be
written in code: accounts, declarations, review notes and release process. Budget
**two to three weeks** for a first submission on each store and **expect at least
one rejection round on iOS**.

## Start these two today — they block submission entirely

1. **Apple Developer Program, organisation account.** An organisation account
   needs a **D-U-N-S number**, and getting one can take weeks on its own. Start it
   before writing any app code. (A personal account is faster but lists an
   individual as the seller, which is wrong for IntegrateSun.)
2. **A public privacy policy URL.** Both stores reject without one. It must be
   reachable without logging in. Once it exists, put it in
   **Admin → Settings → Customer app → Privacy policy URL** — that is where the
   app's More tab and `/api/app/version` read it from.

Neither has a technical dependency on the app, and both have unpredictable lead
times. Everything else on this page can be done in an afternoon.

## Current status of the code

| Requirement | State |
| --- | --- |
| Installable app (PWA), offline read cache, Android + iOS 16.4 push | **Done** — shipped and live |
| Five-tab app structure, camera upload, in-app viewer, share sheet | **Done** |
| Biometric unlock, secure storage, no cleartext traffic | **Done** |
| In-app account deletion route | **Done** — More → Privacy and legal |
| Forced-update check | **Done** — `/api/app/version`, floor set in Admin → Settings |
| Demo account for reviewers | **Done** — `npm run db:demo-customer` |
| Capacitor native projects (`ios/`, `android/`) | **Created and committed** — real launcher icons, hardened manifest |
| Cloud build without a Mac | **Done** — GitHub Actions workflows for both platforms |
| Store listings, screenshots, declarations | **Not started** — needs the accounts above |

The PWA is the recommended first step in the spec (§1, §10): add-to-home-screen
and Android push cost days rather than weeks and will tell you whether customers
actually want an app before you commit to two store listings and a release
cadence. It is already deployed.

## Building the apps — no Mac required

The `android/` and `ios/` projects are in the repository, configured and with
the real launcher icons. Two GitHub Actions workflows build them on hosted
runners, so everything happens in the browser.

**Actions → Build Android app → Run workflow.** Enter your production URL, leave
the type as `debug`, and the run produces an installable APK under Artifacts.
That needs no Apple or Google account at all — download it, open it on an
Android phone, allow installing from that source. It is the fastest way to hold
the real app.

**Actions → Build iOS app → Run workflow.** In `check` mode this compiles the
app on a macOS runner and proves the project builds; it produces nothing
installable, because Apple will not run unsigned code on a device. In
`testflight` mode it produces a signed `.ipa` — that needs the Apple Developer
account and four repository secrets, listed in the workflow file.

Both workflows take the production URL as an input and pass it through
`npx cap sync`, so the shell always points at the deployed app rather than a
hard-coded guess. The shell loading the deployed web app (`server.url`) is what
makes the "web content updates need no release" property in §8 true — only
native changes (plugins, permissions, icons, target SDK) need a submission.

Signing secrets to add before a release build (Settings → Secrets and variables
→ Actions):

| Secret | For |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | The Play upload bundle |
| `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_TEAM_ID` | The App Store `.ipa` |

Neither keystore nor certificate is ever committed — CI writes them from the
secrets at build time and, on iOS, into a throwaway keychain deleted after the
run.

**Locally instead** (if someone does have a Mac and prefers Xcode):

```bash
npm ci
CAPACITOR_APP_URL=https://your-production-domain npx cap sync
npx cap open android   # Android Studio
npx cap open ios       # Xcode
```

Android network security is already hardened:
`android/app/src/main/res/xml/network_security_config.xml` sets
`cleartextTrafficPermitted="false"` with system trust anchors only and no
debug-override block, the manifest references it and sets
`allowBackup="false"`, and `capacitor.config.ts` sets `cleartext: false` and
`allowMixedContent: false`. `POST_NOTIFICATIONS` (Android 13+) and `CAMERA` are
declared.

## Both stores

| Item | What to do |
| --- | --- |
| Icons | `npm run make:icons` generates every size from code. The 512 maskable variant is the Android adaptive icon. |
| Screenshots | Home, Project (stage tracker expanded), Documents, Photos. Use the **demo account**, never a real customer's project. |
| Short description | "Follow your solar installation — where it stands, what happens next, and your documents." |
| Support URL and email | Set in Admin → Settings → Customer app. |
| Age rating | 4+ / Everyone. No user-generated public content, no ads, no purchases. |
| Account deletion | Already in the app: More → Privacy and legal → Request account deletion. It files a request that an admin actions through **Admin → Customers → Anonymise**, which removes the person and keeps the permit, install date and payment history. Both stores accept a request-based flow; both expect it actioned within 30 days. |

### Data safety declarations — declare exactly this

The app collects only what a solar project needs, and none of it is used for
tracking or advertising. Declare, for both Apple's privacy labels and Google's
Data Safety form:

| Data | Collected | Linked to identity | Used for tracking | Why |
| --- | --- | --- | --- | --- |
| Name | Yes | Yes | No | To identify your project |
| Email address | Yes | Yes | No | Login and project updates |
| Phone number | Yes | Yes | No | So the project manager can reach you |
| Physical address | Yes | Yes | No | The installation site |
| Photos | Yes | Yes | No | Only photos the customer chooses to send |
| Precise location | **No** | — | — | The app never requests location |
| Contacts, calendar, health, financial account data | **No** | — | — | Not collected |
| Third-party analytics / advertising identifiers | **No** | — | — | None present |

Data is encrypted in transit (TLS only). Deletion is available in-app. This table
must match what the app actually does — a mismatch is a rejection, and a later
mismatch is a removal.

## Apple specifics

**Guideline 4.2 (minimum functionality) is the real risk.** Apple rejects apps
that are "just a website". Say the following in the review notes, because it is
true and it is exactly what they are checking for:

> This app is not a web view of a marketing site. It provides native
> functionality a browser cannot: push notifications for project milestones and
> appointment reminders; camera capture with on-device compression for uploading
> documents the project manager requests; Face ID / Touch ID unlock; the native
> share sheet for forwarding paperwork to an accountant or lender; and an offline
> read cache so the customer can see their project status with no signal.
>
> Demo account — Email: demo@solarflow.app / Password: (as set) / choose the
> "Customer" door on the sign-in screen. The demo project is in the
> "Inspection & Power On" stage with completed earlier stages, documents, a
> photo, a message thread and one outstanding request, so every screen has
> content.

Other Apple items:

- **Demo account is mandatory** and must keep working. Re-run
  `npm run db:demo-customer` before each submission to reset it.
- **Sign in with Apple** is only required if third-party social login is offered.
  Plain email and password avoids it — do not add Google/Facebook login unless
  you are ready to add Apple too.
- **Push permission** must not be requested at launch. It is not: the app asks
  only after the customer has seen their status once, with an explanation screen
  first (spec §4).

## Google specifics

- **Target API level** rises annually and Play enforces it. Plan one maintenance
  release a year per platform even with no feature work.
- **Closed testing** — new personal developer accounts must run a testing period
  with real testers before production release. Check the current rule for the
  account type you registered.
- **App signing** — let Google manage the signing key. Losing your own key is
  unrecoverable.

## Push notifications

Web push (Android, and iOS 16.4+ once installed) works now. Generate the key pair
once:

```bash
npm run make:vapid
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` on Vercel, then
redeploy. **Regenerating the pair silently unsubscribes every device that has
already opted in**, so store it safely.

For the store builds, the Capacitor push plugin uses FCM (Android) and APNs
(iOS). That needs a Firebase project for `google-services.json`, and an APNs key
uploaded to Firebase, both configured on the machine that builds the native
shells.

Install reminders (48 h and 24 h before) come from `POST /api/push/reminders`.
Add a Vercel cron entry hitting it once a day with `CRON_SECRET`, or press the
button in Admin → Settings. It is safe to call repeatedly — each reminder is
deduped by date and window.

## Release process

- **TestFlight** and **Play internal testing** for the team before every public
  release.
- **Crash reporting** (Sentry or Crashlytics) from day one. Mobile bugs are
  invisible until a customer complains otherwise.
- **Version display** — the app shows version and build under More. That is the
  first thing support should ask for.
- Set `NEXT_PUBLIC_APP_VERSION` and `NEXT_PUBLIC_APP_BUILD` at build time so the
  footer and the forced-update check agree with what the store shipped.

## A note on scale

A homeowner opens this app roughly once a week for four months and then never
again. That is what it should be. It means the app must earn its install in the
first thirty seconds — status, next step, the project manager's phone number —
and it means not building features nobody opens twice. The five tabs are
deliberately the whole app.
