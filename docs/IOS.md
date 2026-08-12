# Shipping this as an iPhone app

The simulation is Rust compiled to WebAssembly, and the front end is a web app
built for touch. There are two ways to get it onto a phone:

1. **Install from Safari** — no Mac, no Xcode, no Apple Developer account.
   Good for yourself and for anyone you can send a link to.
2. **Wrap it in a native shell with Capacitor** — a real `.ipa`, installable
   through TestFlight and submittable to the App Store. Needs a Mac.

Everything the web app needs for both paths is already in the repository.

---

## 1. Install from Safari (fastest)

Host the contents of `www/dist/` on any HTTPS URL (GitHub Pages, Netlify,
Cloudflare Pages — it is all static files), then on the phone:

Open the URL in **Safari** → **Share** → **Add to Home Screen**.

It launches full-screen with no browser chrome, keeps its own icon, and works
offline after the first load. HTTPS is required — the service worker that
provides offline support will not register over plain HTTP (localhost aside).

> Chrome and Firefox on iOS cannot install home-screen apps. Only Safari can.

---

## 2. Native app with Capacitor

Capacitor puts the web app inside a `WKWebView` and gives you a normal Xcode
project. The web layer is unchanged, so anything fixed in the browser is fixed
in the app.

### Prerequisites

| Tool | Notes |
| --- | --- |
| macOS | Xcode is Mac-only; there is no way around this |
| [Xcode](https://developer.apple.com/xcode/) 15+ | Install the iOS platform and command line tools |
| [Rust](https://rustup.rs) | For the simulation crate |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) | Compiles the crate to wasm |
| [Node](https://nodejs.org) 18+ | Bundles the front end |
| CocoaPods (`sudo gem install cocoapods`) | Capacitor uses it for iOS dependencies |
| Apple Developer Program ($99/year) | Only needed for TestFlight and the App Store, not for running on your own device |

### Build

```sh
# 1. Rust -> wasm
wasm-pack build

# 2. Web bundle -> www/dist
cd www
npm install
npm run build

# 3. Create the Xcode project (first time only)
npm run ios:add

# 4. Open it
npm run ios:open
```

After the first time, `npm run ios:sync` rebuilds the web bundle and copies it
into the iOS project. Run it after every change to the Rust or the front end —
Capacitor copies files in, it does not read them live.

### In Xcode

1. Select the **App** target → **Signing & Capabilities** → pick your Team.
   Xcode will provision automatically.
2. Change the bundle identifier. It defaults to `com.arnauddecuyper.gameoflife`
   from `www/capacitor.config.json`; it has to be unique across the App Store,
   and it has to match whatever you register in App Store Connect. Change it in
   `capacitor.config.json` **and** in Xcode so the two agree.
3. Set the app icon: drag `www/icons/icon-1024.png` onto the 1024pt slot in
   `App/Assets.xcassets/AppIcon.appiconset`. Xcode 15 and later generate the
   rest of the sizes from it. The icon deliberately has **no alpha channel** —
   App Store Connect rejects icons that have one.
4. Pick a device or simulator and press ⌘R.

### Settings worth knowing about

`www/capacitor.config.json` sets:

- `backgroundColor` — what shows behind the web view before the first paint and
  during rubber-banding, matched to the app's dark background so there is no
  white flash on launch.
- `scrollEnabled: false` — the web view itself must not scroll; the grid handles
  its own touches.
- `contentInset: "never"` — the CSS already pads for the notch and the home
  indicator with `env(safe-area-inset-*)`. Letting the web view inset as well
  would apply the padding twice.

Supported orientations are an Xcode setting (target → General → Deployment
Info). The layout handles both portrait and landscape, including the rotation
itself: the grid is refitted and the live pattern is carried across.

### Submitting to the App Store

- **Screenshots** are required at 6.7" and 6.5" sizes. Simulator → ⌘S captures
  correctly-sized ones.
- **Privacy**: the app collects nothing, makes no network requests after load,
  and has no third-party SDKs. In App Store Connect, answer "No" to data
  collection and fill in the privacy nutrition label accordingly.
- **Export compliance**: no encryption beyond HTTPS, so the standard exemption
  applies. Adding `ITSAppUsesNonExemptEncryption = NO` to `Info.plist` stops
  Xcode asking on every upload.
- **Review notes**: reviewers sometimes flag simple simulations as
  "not enough functionality" under guideline 4.2. Describing what Conway's Game
  of Life is, and that the app lets you draw and evolve your own patterns,
  heads that off.

---

## Testing on a real phone during development

The simulator does not reproduce touch properly — drawing with a finger,
momentum, the safe-area insets and the wake lock all behave differently on real
hardware. The dev server binds to every interface for this reason:

```sh
cd www
npm start
```

Then open `http://<your-mac's-LAN-IP>:8080` in Safari on a phone on the same
Wi-Fi. To debug it: Safari on the Mac → Develop → *your iPhone* → the page. The
Rust panic hook routes wasm panics to that console as readable messages.

Note that the service worker will not register over a plain-HTTP LAN address,
so offline behaviour needs testing against the built `dist/` over HTTPS or
inside the native app, where the files are local anyway.

---

## What makes the web app iPhone-ready

For reference, the changes that matter on a phone:

- The grid is sized to the viewport at the device's pixel ratio, instead of a
  fixed 118×64 board that ran off the side of the screen.
- Touch input: tap toggles a cell, drag paints a line of them. Pointer capture
  keeps a drag alive if the finger slides off the canvas.
- `touch-action` and a locked viewport stop pinch-zoom, double-tap zoom and the
  rubber-band scroll from fighting with drawing on the grid. It is done in CSS
  rather than by cancelling `touchend`, which would also cancel the click
  Safari synthesises from it and drop every second tap on a button.
- Safe-area insets keep the controls clear of the notch and the home indicator.
- Controls are at least 44pt, the minimum comfortable touch target.
- The simulation pauses when the app is backgrounded, and takes a screen wake
  lock only while it is actually running.
- Light and dark colour schemes, following the system setting.
- A web app manifest, apple-touch-icon, and a service worker for offline use.
