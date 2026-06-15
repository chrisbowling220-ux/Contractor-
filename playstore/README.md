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
