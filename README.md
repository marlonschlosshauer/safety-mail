# An email client for safety (not security)

An initial proof of concept is implemented. See [PROTOTYPE.md](PROTOTYPE.md) for
demo launch instructions, T-Online setup, validation, and current limitations.
The requirements below remain the product specification.

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

Use a small authenticated server endpoint, such as a Vercel Function, between the
desktop application and Vercel AI Gateway. The endpoint keeps the shared
`AI_GATEWAY_API_KEY` out of the Electron bundle and provides request validation,
rate limiting, usage controls, and one place to observe screening failures.

The endpoint calls TypeSafe AI's Jev model through AI Gateway using the model ID
`typesafe-ai/jev`. Use the Vercel AI SDK decision API rather than a chat or text
generation API. AI Gateway remains the integration boundary for authentication,
billing, and model access; Jev is the selected decision model.

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

Jev is not a general-purpose LLM and does not generate an explanation. It is a
probabilistic decision model: the application supplies shared state and typed
questions, and Jev returns choices, scores, or boolean probabilities. Multiple
questions can be evaluated in one request.

The Jev result is one signal, not an authority. Screening should combine
deterministic checks with Jev's assessment, and the application must remain in
control of thresholds, warning text, and permitted actions.

### Deterministic signals

- Sender and `Reply-To` mismatch.
- Display-name impersonation.
- Lookalike, Unicode, or punycode domains.
- Link text whose displayed destination differs from its actual destination.
- IP-address links, unusual URL schemes, redirects, and URL shorteners.
- Login forms or requests for passwords, codes, payments, or urgent action.
- Suspicious attachment extensions or misleading double extensions.
- Provider authentication and spam results, when their provenance is trusted.

### Jev input

Send a bounded, normalized object as Jev's `state`, never arbitrary raw MIME:

- `From`, `Reply-To`, `Return-Path`, and subject.
- Plain-text body.
- Extracted visible-text/destination link pairs.
- Attachment metadata.
- Deterministic findings.

Strip fields that are not needed for screening and enforce length limits before
the request leaves the device. Describe message text as hostile, untrusted data;
instructions contained in an email are evidence to classify, not instructions
for Jev or the application. Jev receives no tools and cannot initiate actions.

### Decision contract

Use the Vercel AI SDK's decision API and the Gateway decision-model adapter. The
API is currently experimental, so pin compatible `ai` and `@ai-sdk/gateway`
versions and cover the response handling with contract tests.

```ts
import { gateway } from "@ai-sdk/gateway";
import { experimental_decide as decide } from "ai";

const result = await decide({
  model: gateway.decisionModel("typesafe-ai/jev"),
  state: screeningInput,
  questions: {
    risk: {
      type: "choice",
      instructions:
        "Classify the likelihood that this email is a phishing attempt.",
      criteria: {
        low: "No material phishing evidence is present.",
        medium: "Some evidence is suspicious or ambiguous and needs caution.",
        high: "Strong evidence indicates credential theft, fraud, or impersonation.",
        insufficient_evidence:
          "The supplied state is insufficient to classify.",
      },
    },
    requestsSecret: {
      type: "boolean",
      instructions:
        "Does the email ask for a password, login, or security code?",
    },
    requestsMoney: {
      type: "boolean",
      instructions: "Does the email ask for a payment or financial transfer?",
    },
    usesDeceptiveLinks: {
      type: "boolean",
      instructions: "Do the link labels or destinations appear deceptive?",
    },
    impersonatesTrustedParty: {
      type: "boolean",
      instructions:
        "Does the email appear to impersonate a trusted person or organization?",
    },
  },
});
```

Choice answers contain the selected label and may include a probability
distribution. Boolean answers contain the probability that the statement is
true. A low boolean probability means Jev favors `false`; it is not a generic
confidence score. Do not ask Jev for free-form reasons or a recommended action.
Instead, map deterministic findings and thresholded boolean answers to fixed,
human-written warning text.

Choose thresholds using a representative labeled test set, with false negatives
weighted more heavily than false positives. Keep an explicit review band around
uncertain results and store the model ID, question-set version, answers, and
threshold version with each assessment. Recalibrate before changing the model,
provider route, questions, or thresholds.

Validate the returned answer keys and numeric ranges. Timeouts, provider errors,
malformed answers, or `insufficient_evidence` produce an
`unavailable`/`not_checked` state rather than a low-risk result. Deterministic
high-risk findings must still trigger a warning even when Jev returns `low`.

The UI should use language such as `No obvious warning signs found` instead of
`This email is safe`.

### Privacy

Email contents are personal data. TypeSafe AI's privacy policy says it does not
train or fine-tune models on customer input, but the current AI Gateway listing
does not advertise zero-data-retention for Jev. Do not treat no-training as
no-retention. Before release, verify and document the retention, processing
region, and subprocessors for Vercel and the selected Jev provider.

Pin the reviewed provider route where possible and do not add fallback providers
without a separate privacy review. Document exactly which fields leave the
device, minimize them, and obtain the account owner's informed consent. If the
required data-handling guarantees are unavailable, keep screening local or do not
send message contents.

References:

- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Jev on Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev)
- [Vercel AI SDK decision API](https://vercel.com/i/ai-sdk-evaluation-to-decisions)
- [TypeSafe AI](https://typesafe.ai/)
- [TypeSafe AI privacy policy](https://typesafe.ai/legal/privacy-policy)

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
- It is okay to mock the AI integration in the very first steps.
