# Publishing BuildPro+ to the Google Play Store (TWA)

BuildPro+ is a PWA hosted at **https://builderspro.cc**. We ship it to Play as a
**Trusted Web Activity (TWA)** — a thin Android wrapper that opens the live PWA
full-screen with no browser chrome. Users get a real Play Store install; you keep
shipping updates by just deploying the web app (no new Play upload needed unless
you change the wrapper).

## What's already done (in this repo)
- ✅ PNG app icons: `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`
- ✅ Web manifest with PNG + maskable icons: `public/manifest.webmanifest`
- ✅ Digital Asset Links file: `public/.well-known/assetlinks.json` (fingerprint placeholder — see step 4)
- ✅ Bubblewrap config: `playstore/twa-manifest.json`
- ✅ Privacy Policy + Terms pages live at `/privacy` and `/terms`

## What needs YOU (can't be automated)
1. A **Google Play Developer account** — one-time **$25**: https://play.google.com/console/signup
2. **Java JDK 17+** and the **Android SDK** installed locally (Bubblewrap needs them).
3. Final **upload + store listing** in Play Console (interactive).

## Steps

### 1. Install Bubblewrap
```bash
npm install -g @bubblewrap/cli
```

### 2. Initialize from the live manifest
```bash
cd playstore
bubblewrap init --manifest=https://builderspro.cc/manifest.webmanifest
```
When prompted, accept the values from `twa-manifest.json` (package id `cc.builderspro.app`).
Bubblewrap will generate/sign a keystore — **back it up** (lose it = can't update the app).

### 3. Build the Android App Bundle
```bash
bubblewrap build
```
Produces `app-release-bundle.aab` (upload this) and `app-release-signed.apk` (for local testing).

### 4. Wire up Digital Asset Links (removes the URL bar)
After you create the app in Play Console and enable **Play App Signing**, Play shows you the
**SHA-256 certificate fingerprint** (Setup → App integrity). Copy it into
`public/.well-known/assetlinks.json` (replace `REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT`),
then redeploy hosting:
```bash
npm run build && firebase deploy --only hosting
```
Verify it serves: `curl https://builderspro.cc/.well-known/assetlinks.json`

> Bubblewrap can also print the local keystore fingerprint with `bubblewrap fingerprint`.
> Add BOTH the local upload key fingerprint AND the Play App Signing fingerprint to be safe.

### 5. Create the app in Play Console & upload
- New app → name **BuildPro+**, category **Business**.
- Upload `app-release-bundle.aab` to a track (Internal testing first, then Production).
- Fill the listing from `playstore/LISTING.md`.
- Complete: Privacy Policy URL (`https://builderspro.cc/privacy`), Data safety form,
  Content rating questionnaire, target audience, screenshots (see below).

### 6. Screenshots required by Play
- Phone: at least 2 (1080×1920 portrait works). Capture the dashboard, a quote, an invoice.
- A 512×512 app icon (use `public/icon-512.png`) and a 1024×500 feature graphic.

## Updating later
- **PWA changes** (features, fixes): just `firebase deploy` — TWA loads the live site, no Play upload.
- **Wrapper changes** (icon, name, permissions): bump `appVersionCode` in `twa-manifest.json`,
  `bubblewrap build`, upload the new `.aab`.

## Readiness check — 2026-11-11

Checked against the repo and the live site. Nothing was built, signed or uploaded.

**Ready**
- Web manifest, 192/512/maskable PNG icons and `assetlinks.json` are all served by
  the live site with the right content types.
- `twa-manifest.json` matches the manifest (package `cc.builderspro.app`, portrait,
  `#1a1f2e` theme). Notification delegation is on, which the in-app reminders use.
- Android Back moves between screens (hash navigation), instead of closing the app.
- Offline launch page: `public/sw.js` shows `/offline.html` when the app is opened
  with no signal, instead of a browser error. It caches nothing else.
- Account deletion (a Play requirement for apps with accounts): Settings → Delete my
  account, and the public page `https://builderspro.cc/delete-account` — paste that
  URL into Play Console → App content → Data safety → "Delete account URL".
  Requests land in the Firestore collection `accountDeletionRequests`; act on each
  within 30 days. Nothing is deleted automatically.

**Needs the owner**
1. `assetlinks.json` still holds the placeholder fingerprint. Until the real Play App
   Signing SHA-256 is in it and hosting is redeployed, the app shows a browser address bar.
2. This machine has Java 21 and Bubblewrap but **no Android SDK** (`~/.bubblewrap/config.json`
   is empty). The first `bubblewrap` run asks to download a JDK/SDK and accept Google's
   licences — yours to accept.
3. `bubblewrap init` creates the signing keystore. Back it up somewhere other than this
   machine; it is never committed here (`*.keystore` / `*.jks` should stay out of git).
4. **Billing policy — confirm before submitting.** The app sells the Pro subscription and
   quote packs through Stripe. Google Play generally requires Play Billing for digital
   goods sold inside an Android app, with region-specific exceptions and programs that
   change. Invoices a customer pays a contractor are payments for real-world services and
   are not the concern; the Pro upgrade screens are. Check the current Play Payments
   policy (or hide the upgrade buttons when the app runs as the Android wrapper,
   `?source=twa`) before the first upload. This is a policy reading, not legal advice.
5. Data safety form: the app collects name, email, business details, customer contact
   details, photos and payment status; card numbers go to Stripe and are never seen by
   the app.
6. Not tested on a real Android device. Before production: install the internal-testing
   build and check sign-in, camera capture, a card payment and the Back button.
