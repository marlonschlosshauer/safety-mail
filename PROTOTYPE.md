# Clear Mail proof of concept

This is a runnable Electron / React / TypeScript prototype for the receive-only
client described in README.md. It starts with three fictional messages. No account
or AI service is contacted in demo mode.

## Try the demo

Use Node.js 24 LTS (at least 22.12) and npm on an Ubuntu desktop:

```sh
npm ci
npm start
```

Installation downloads the Electron runtime. `npm start` builds both the main
process and renderer before opening the app. No development web server is used
by the desktop app.

For a browser-only preview:

```sh
npm run build
npm run preview
```

Open the localhost URL printed by Vite. The preview only uses fixtures and cannot
connect to IMAP or open external websites. The desktop app implements those
operations in its main process.

The first message demonstrates deceptive links and urgency. Anna’s message shows
the limited local-check result. The library message demonstrates `Not checked`
and attachment metadata. Select messages using Tab and Enter; focus moves to the
reader title. Link confirmation focuses “Stay in mail,” traps Tab within the
dialog, and supports Escape. Larger text and contrast preferences persist.

## Try a real T-Online account

Create the separate **Passwort für E-Mail-Programme** in the T-Online account
settings. The portal password is not the email-program password.

After installing dependencies, launch from a terminal:

```sh
bash scripts/connect.sh
```

The script builds before asking for credentials, hides password entry, and passes
credentials only to the Electron launch process. Main removes the credential
environment variables before creating the renderer. There is no password API in
the preload bridge and credentials are never returned to the renderer. This
terminal setup deliberately avoids adding a password-entry screen to React in
the proof of concept. Main retains credentials in memory for reconnects.

Session-only credentials are the default. To request encrypted persistence:

```sh
MAIL_REMEMBER=1 bash scripts/connect.sh
```

Persistence requires Electron safeStorage encryption and a supported OS keyring.
On Linux, `basic_text` and `unknown` backends are refused; the app continues with
session-only credentials and reports that in the connection status. After
successful persistence, subsequent launches can use:

```sh
MAIL_MODE=live npm start
```

The server is fixed to `secureimap.t-online.de:993` with TLS certificate
verification. INBOX is selected read-only. Opening a message never sets `\Seen`,
and the client has no IMAP mutation operations. All synchronization is independent
of React. ImapFlow automatically handles IDLE; a periodic one-minute fetch catches
missed updates. Disconnections retry with exponential backoff and jitter.

Initial synchronization fetches up to 100 recent messages in the last 5,000 UID
positions. Later synchronization scans new UIDs in bounded windows and processes
100 messages per batch until caught up. Cached keys contain account, INBOX,
UIDVALIDITY, and UID. Cursor updates and their messages commit together.
UIDVALIDITY changes replace the local mapping. Flags reconcile for the latest 100
cached UIDs. There is no server deletion, moving, or marking read. Mail removed on
another client remains cached in this prototype.

Each account has a separate SQLite cache. Account metadata remembers which cache
to display after a session-only restart, so offline mail remains readable. Cache
files are in Electron’s user-data directory, usually `~/.config/Clear Mail` on
Linux. Their content is local plaintext with private file permissions; only the
optional saved credential file is encrypted. Protect the desktop account and
disk as appropriate for personal email.

## Implemented defenses

- Sandboxed renderer, context isolation, no Node integration, restricted CSP,
  blocked navigation/popups/webviews, denied renderer permissions and networking.
- Typed preload methods; every IPC handler validates the calling window, main
  frame, exact bundled page URL, and input shape. No general IPC forwarding.
- Streaming MIME parsing, a 5 MiB raw-message cap, a 100,000-character body cap,
  a conservative multipart-complexity cap, and bounded links/attachment metadata.
  Attachment bytes are drained and discarded, never retained or opened. Obtaining
  the full MIME body does transfer attachment bytes within the total message cap.
- HTML is only parsed inertly for text and link extraction in main. It is never
  rendered. Remote images, scripts, styles, fonts, forms, and tracking content do
  not load in the reader. Parse failures/oversize produce `Not checked` placeholders.
- Local checks for reply mismatches, deceptive link labels, provider-name/domain
  mismatches, simple provider lookalikes, punycode, numeric domains, shorteners,
  redirect query parameters, HTTP, secret/payment/urgency language, and suspicious
  attachment extensions. These rules are deliberately limited heuristics, not a
  calibrated phishing detector.
- Suspicious and unchecked links require warning acknowledgement. Main issues
  short-lived, single-use confirmation tokens for stored links, revalidates the
  destination, then displays a native confirmation. Only HTTP(S) links without URL
  credentials can reach `shell.openExternal`. Redirects after leaving the app are
  outside the prototype’s control.

## AI and remaining work

AI screening is disabled: no email data leaves the device for screening, and no
Gateway key or service credential is included. Local checks are always labelled
as local; “No obvious warning signs found” does not claim safety. The demo’s
unchecked message is an explicit fixture, not a fabricated AI result.

An authenticated endpoint, pinned Vercel decision-API/Gateway versions, validated
Jev answer contracts, provider/privacy review and account-owner consent, calibrated
thresholds, and assessment provenance beyond the local rule version remain future
work. No chat-generation API or pretend Jev integration has been added.

Also remaining: graphical account setup, attachment previews, a polished
authentication recovery flow, full-mailbox reconciliation, QRESYNC cursor
persistence, installer/signing, and testing with the intended user on Ubuntu using
Orca and GNOME high contrast. This is source runnable with Electron, not a packaged
release. Live T-Online authentication and actual keyring persistence have not been
tested here because no account credentials/keyring were available.

## Validation

```sh
npm run typecheck
npm run build
npm test
npm run test:ui
npm run test:desktop
```

20 automated unit/integration cases cover SQLite restart/deduplication/pagination,
UIDVALIDITY reset, persistence rollback, bounded parsing, discarded attachments,
destination checks/expiry/reuse, local risk rules, read-only UID synchronization,
download failure, repeated reconnect failure/recovery, and the initial window.
3 Chromium UI cases cover warnings, true destinations, keyboard/focus/Escape,
preferences, and blocking remote content. All passed in the build environment.

The desktop smoke test passed using actual Electron with a temporary Xvfb display.
It checks the preload API, absent renderer Node/general IPC, invalid IPC inputs,
rejection of a second renderer, risk acknowledgement, native confirmation with
cancel/continue, exact shell destination, and token reuse. It stubs the OS browser
launcher and native dialog responses to avoid opening a website during tests.

UI tests use `/usr/bin/chromium` by default; set `CHROMIUM_PATH` to another installed
Chromium binary. Desktop tests need a working display. In this container only,
`ELECTRON_TEST_CONTAINER=1` supplied `--no-sandbox --disable-gpu` for test startup.
Production launch has no such flags; the container test does not prove Ubuntu OS
sandbox or keyring compatibility. Retest the normal launch on the target desktop.

See `src/main` for privileged operations, `src/shared/types.ts` for the bridge
contract, and `src/renderer` for presentation. The root README remains the broader
product specification.
