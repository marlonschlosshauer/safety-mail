# An email client with UX optimized for safety (not security)

A small, receive-only desktop email client for a visually impaired user running
Ubuntu. The application should make ordinary email easier to read and make
potential phishing attempts much harder to act on accidentally.

The initial account is hosted by T-Online. The client will be built with React,
TypeScript, and Electron.

## Product principles

- Optimize for clarity, legibility, and a small number of predictable actions.
- Warn about suspicious messages without claiming that any message is safe.
- Never delete, move, or otherwise modify mail automatically.
- Prefer plain text and blocked content over faithfully reproducing hostile HTML.
- Keep mail synchronization independent from the React UI.
- Degrade visibly: if a message has not been screened, show `Not checked`, never
  `Safe`.

## Initial scope

### Included

- Connect one T-Online account over IMAP.
- Synchronize and locally cache the inbox.
- Show unread state, sender, subject, date, and message contents.
- Receive new-mail updates while the application is open.
- Screen new messages for phishing indicators.
- Present large, high-contrast warnings and explain why a message looks risky.
- Open links only after showing their real destination.

### Deferred

- Sending mail and SMTP.
- Drafts, replies, forwarding, and signatures.
- Automatic deletion, spam filing, or mailbox cleanup.
- Multiple accounts and complex folder management.
- Attachment previewing.
- Contact and calendar synchronization.

## Architecture

### Electron main process

The main process owns all privileged operations:

- Connect to the IMAP server using `imapflow`.
- Parse MIME messages using `mailparser`.
- Store normalized messages and synchronization state in SQLite.
- Store credentials using Electron `safeStorage`.
- Submit phishing-screening requests.
- Expose a small, typed IPC surface to the renderer.

The React renderer must never receive the IMAP password, AI Gateway credential,
raw filesystem access, or general-purpose Electron APIs.

### Preload bridge

Expose specific operations rather than forwarding `ipcRenderer` directly. A
minimal first API might contain:

```ts
type MailApi = {
  listMessages(input: {
    cursor?: string;
    limit: number;
  }): Promise<MessageSummaryPage>;
  getMessage(id: string): Promise<MessageDetails>;
  refreshInbox(): Promise<void>;
  getSyncStatus(): Promise<SyncStatus>;
  openExternalLink(input: { messageId: string; url: string }): Promise<void>;
};
```

Every IPC handler must validate its sender and input.

### React renderer

The renderer is responsible only for presentation and user interaction:

- Setup and connection-status screens.
- Inbox list.
- Message reader.
- Phishing warning and link-confirmation dialogs.
- Accessibility preferences such as text size and contrast.

Use `nodeIntegration: false`, `contextIsolation: true`, and renderer sandboxing.
Apply a restrictive Content Security Policy and prevent unrequested navigation or
new windows.

### Screening service

Prefer a small authenticated server endpoint, such as a Vercel Function, between
the desktop application and Vercel AI Gateway. It keeps the shared Gateway API
key out of the Electron bundle and provides rate limiting and request validation.

For a strictly personal build, a user-owned API key may instead be stored locally,
but no reusable project credential should be compiled into or shipped with the
application.

## T-Online configuration

Use IMAP rather than POP3 so the server remains the source of truth.

| Setting   | Value                                             |
| --------- | ------------------------------------------------- |
| Server    | `secureimap.t-online.de`                          |
| Port      | `993`                                             |
| Transport | SSL/TLS                                           |
| Username  | Full email address                                |
| Password  | Separate T-Online "Passwort für E-Mail-Programme" |

The password for email programs must be created in the T-Online account settings;
it is separate from the normal web-portal login password.

Reference: [Telekom incoming and outgoing server settings](https://www.telekom.de/hilfe/apps-dienste/e-mail/posteingang-postausgang-server)

## IMAP synchronization

Do not implement the IMAP protocol directly. Use
[`imapflow`](https://github.com/postalsys/imapflow), which supports TypeScript,
mailbox locking, IDLE, CONDSTORE, QRESYNC, and streaming message retrieval.

### Initial synchronization

1. Connect over TLS and authenticate.
2. Open `INBOX` read-only.
3. Record the mailbox's `UIDVALIDITY` and current UID range.
4. Fetch envelopes and body structure for a bounded recent window.
5. Fetch and parse message bodies separately.
6. Persist the synchronization cursor only after the corresponding messages have
   been committed successfully.

### Incremental synchronization

- Address messages by UID, never by sequence number.
- Persist the highest successfully synchronized UID per mailbox.
- Key cached messages by account, mailbox, `UIDVALIDITY`, and UID.
- Do not use `Message-ID` as a unique identifier.
- Invalidate the local UID mapping if `UIDVALIDITY` changes.
- Use IMAP IDLE for prompt new-mail notifications.
- Reconnect with exponential backoff and jitter after disconnects.
- Run a periodic reconciliation fetch so a missed IDLE notification cannot lose
  mail.
- Prefer CONDSTORE/QRESYNC when supported, but retain a safe fallback for servers
  without those extensions.

The first version should keep the mailbox read-only. That avoids accidentally
marking messages as read or changing server state while the synchronization logic
is still being proven.

### MIME processing

Use [`mailparser`](https://nodemailer.com/extras/mailparser) to parse raw RFC 822
messages. Apply explicit limits to total message size, body size, MIME nesting,
and attachment metadata. Do not buffer large attachments in memory.

Store a normalized representation containing:

- Sender name and address.
- `Reply-To` and `Return-Path` when present.
- Subject and sent/received dates.
- Plain-text body.
- Sanitized display body, if HTML support is enabled.
- Extracted links as visible-text/destination pairs.
- Attachment names, sizes, and MIME types without downloading their contents.
- Selected authentication and spam headers.

## Safe message rendering

Email is untrusted content. The default reader should display normalized plain
text rather than raw HTML.

If HTML display is added later:

- Sanitize it with a maintained allowlist-based sanitizer.
- Render it in a sandboxed iframe without scripts, forms, popups, or same-origin
  privileges.
- Block remote images, stylesheets, fonts, media, and tracking pixels.
- Allow only explicitly handled URL schemes.
- Never pass email URLs directly to `shell.openExternal`.
- Show the actual hostname and require confirmation before opening a link.
- Make suspicious-message links unavailable until the user acknowledges a clear
  warning.

`mailparser` explicitly does not sanitize the HTML it returns.

## Phishing screening

The LLM is one signal, not an authority. Screening should combine deterministic
checks with a structured model assessment.

### Deterministic signals

- Sender and `Reply-To` mismatch.
- Display-name impersonation.
- Lookalike, Unicode, or punycode domains.
- Link text whose displayed destination differs from its actual destination.
- IP-address links, unusual URL schemes, redirects, and URL shorteners.
- Login forms or requests for passwords, codes, payments, or urgent action.
- Suspicious attachment extensions or misleading double extensions.
- Provider authentication and spam results, when their provenance is trusted.

### Model input

Send a bounded, normalized representation rather than arbitrary raw MIME:

- `From`, `Reply-To`, `Return-Path`, and subject.
- Plain-text body.
- Extracted visible-text/destination link pairs.
- Attachment metadata.
- Deterministic findings.

Email contents must be delimited and described as hostile, untrusted data. The
model receives no tools and cannot initiate actions. This reduces, but does not
eliminate, prompt-injection risk.

### Model output

Require schema-validated structured output, for example:

```ts
type PhishingAssessment = {
  risk: "low" | "medium" | "high";
  confidence: number;
  reasons: string[];
  suspiciousLinks: string[];
  recommendedAction: string;
};
```

Reject malformed responses. Timeouts, provider errors, or rejected responses
produce an `unavailable`/`not_checked` state rather than a low-risk result.

The UI should use language such as `No obvious warning signs found` instead of
`This email is safe`.

### Privacy

Email contents are personal data. Use Vercel AI Gateway's no-training control and,
where available for the selected plan and provider, zero-data-retention routing.
Document which fields leave the device and obtain the account owner's consent.

References:

- [Vercel AI Gateway SDKs and APIs](https://vercel.com/docs/ai-gateway/sdks-and-apis)
- [Vercel AI Gateway privacy controls](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway)

## Credential storage

Store the T-Online email-program password with Electron `safeStorage`, preferably
using its asynchronous API. On Linux, verify that a real Secret Service or KWallet
backend is active. Refuse to persist the password if Electron reports the insecure
`basic_text` backend; offer session-only entry instead.

References:

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/)

## Accessibility and interaction

- Default to large type, generous line height, and high contrast.
- Support keyboard-only operation with a very small tab order.
- Keep the inbox and reader layouts stable between interactions.
- Use text and icons together; never communicate risk with color alone.
- Announce new messages and risk warnings through accessible live regions without
  repeatedly interrupting the user.
- Provide one obvious primary action per screen and generous click targets.
- Avoid gestures, hidden actions, hover-only information, and dense toolbars.
- Preserve zoom and text-size preferences across launches.
- Test with GNOME's screen reader and high-contrast settings on the target Ubuntu
  machine.

## Suggested local data model

- `accounts`: non-secret account metadata and connection settings.
- `mailboxes`: path, `UIDVALIDITY`, highest UID, and highest modification sequence.
- `messages`: normalized headers, bodies, flags, dates, and synchronization keys.
- `links`: message ID, visible text, normalized URL, hostname, and local findings.
- `attachments`: metadata only for the initial version.
- `assessments`: deterministic findings, model result, model identifier, prompt
  version, timestamps, and status.

Database writes for messages and synchronization cursors should be transactional.

## Delivery plan

### Phase 1: Read-only mail prototype

- Scaffold Electron, React, and TypeScript with a secure preload bridge.
- Connect to a test IMAP account and T-Online.
- Implement bounded initial and incremental inbox synchronization.
- Parse MIME and show a plain-text message list and reader.
- Add SQLite caching and encrypted credential storage.

### Phase 2: Defensive rendering

- Extract, normalize, and classify links.
- Add destination-confirmation UI.
- Block remote content and unsafe URL schemes.
- Add message-size limits and resilient parser error handling.
- Review Electron configuration against its security checklist.

### Phase 3: Phishing assessment

- Implement deterministic checks first.
- Add the authenticated screening endpoint and Gateway integration.
- Validate structured model output and persist assessment provenance.
- Add explicit low, medium, high, and not-checked UI states.
- Test prompt injection, unavailable providers, timeouts, and malformed output.

### Phase 4: Accessibility hardening

- Test keyboard navigation and screen-reader output.
- Tune typography, spacing, contrast, focus indicators, and warning language with
  the intended user.
- Add a simple recovery screen for authentication and connection failures.
- Package and test the application on the target Ubuntu installation.

## MVP acceptance criteria

- Restarting the app does not duplicate or lose cached messages.
- Disconnecting the network and reconnecting eventually catches up automatically.
- A server reconnect or missed IDLE event does not lose new mail.
- Opening a message does not execute scripts or load remote resources.
- No link opens without showing its true destination first.
- A failed screening request is never displayed as a safe result.
- The IMAP password and Gateway key never reach the React renderer.
- The primary inbox and reader flows work with keyboard-only navigation, large
  text, and a screen reader.
