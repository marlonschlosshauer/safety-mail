import { ImapFlow } from 'imapflow';
import type { MailStore } from './store.js';
import type { SyncStatus } from '../shared/types.js';
import { MAX_MESSAGE_BYTES, parseMessage, unavailableMessage } from './parse.js';

export type Credentials = { username: string; password: string };
export class InboxSync {
  private client?: ImapFlow;
  private busy?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private reconcile?: ReturnType<typeof setInterval>;
  private stopped = false;
  private failures = 0;
  private dirty = false;
  status: SyncStatus;
  constructor(private store: MailStore, private credentials: Credentials | undefined, private changed: () => void) {
    this.status = { mode: 'live', state: credentials ? 'offline' : 'needs_credentials',
      message: credentials ? 'Ready to connect.' : 'Set up your email-program credentials using the launch instructions.', account: credentials?.username };
  }
  refresh(): Promise<void> {
    if (this.stopped || !this.credentials) return Promise.resolve();
    if (this.busy) { this.dirty = true; return this.busy; }
    clearTimeout(this.timer);
    this.timer = undefined;
    const work = this.run().catch(() => {
      this.setStatus('offline', 'Connection interrupted. Your cached inbox is available. Retrying automatically.');
      const client = this.client;
      this.client = undefined;
      client?.close();
      this.scheduleReconnect();
    }).finally(() => {
      this.busy = undefined;
      if (this.dirty && this.client && !this.stopped) { this.dirty = false; void this.refresh(); }
    });
    this.busy = work;
    return work;
  }
  private setStatus(state: SyncStatus['state'], message: string) {
    this.status = { ...this.status, state, message }; this.changed();
  }
  private scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)) * (0.8 + Math.random() * 0.4);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
  }
  private async run() {
    if (!this.client) {
      this.setStatus('connecting', 'Connecting to T-Online…');
      const credentials = this.credentials!;
      const client = new ImapFlow({ host: 'secureimap.t-online.de', port: 993, secure: true,
        auth: { user: credentials.username, pass: credentials.password },
        logger: false, tls: { rejectUnauthorized: true }, maxIdleTime: 4 * 60_000,
        connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 5 * 60_000 });
      this.client = client;
      client.on('exists', () => { void this.refresh(); });
      client.on('flags', () => { void this.refresh(); });
      client.on('error', () => { client.close(); });
      client.on('close', () => {
        if (this.client === client) {
          this.client = undefined;
          this.setStatus('offline', 'Disconnected. Cached messages remain available. Retrying automatically.');
          this.scheduleReconnect();
        }
      });
      await client.connect();
    }
    const client = this.client;
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      if (!client.mailbox) throw new Error('No inbox selected.');
      const validity = String(client.mailbox.uidValidity);
      const cursor = this.store.cursor(this.credentials!.username);
      const high = cursor?.validity === validity ? cursor.highest : 0;
      const upper = client.mailbox.uidNext - 1;
      // SEARCH is explicitly UID-based. Never use n:* when n exceeds UIDNEXT:
      // IMAP's reversed range semantics could otherwise fetch the last message again.
      const lower = high === 0 ? Math.max(1, upper - 4999) : high + 1;
      const rangeUpper = high === 0 ? upper : Math.min(upper, lower + 4999);
      const found = upper >= lower ? await client.search({ uid: `${lower}:${rangeUpper}` }, { uid: true }) : [];
      const candidates = (found || []).filter(uid => uid > high).sort((a, b) => a - b);
      const uids = high === 0 ? candidates.slice(-100) : candidates.slice(0, 100);
      let highest = high;
      for (const uid of uids) {
        const meta = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, size: true, internalDate: true }, { uid: true });
        if (!meta) { highest = uid; continue; } // Expunged between SEARCH and FETCH.
        const input = { account: this.credentials!.username, validity, uid,
          unread: !meta.flags?.has('\\Seen'), date: meta.internalDate instanceof Date ? meta.internalDate : undefined };
        let message;
        if ((meta.size ?? Infinity) > MAX_MESSAGE_BYTES) {
          message = unavailableMessage({ ...input, subject: meta.envelope?.subject, senderName: meta.envelope?.from?.[0]?.name,
            senderAddress: meta.envelope?.from?.[0]?.address });
        } else {
          const downloaded = await client.download(String(uid), undefined, { uid: true });
          if (!downloaded.content) { highest = uid; continue; }
          try { message = await parseMessage(downloaded.content, input); }
          catch {
            if (!client.usable || downloaded.content.errored) throw new Error('Disconnected while reading a message.');
            message = unavailableMessage({ ...input, subject: meta.envelope?.subject, senderName: meta.envelope?.from?.[0]?.name,
              senderAddress: meta.envelope?.from?.[0]?.address });
          }
        }
        // Commit the message and its UID cursor together. A failure cannot advance the cursor.
        this.store.commitBatch(this.credentials!.username, validity, [message], uid);
        highest = uid;
        this.changed();
      }
      this.store.commitBatch(this.credentials!.username, validity, [], highest);
      // Reconcile flags for a bounded recent window; retain cached removed mail in this POC.
      if (client.mailbox.exists) {
        const window = this.store.recentUids(this.credentials!.username);
        if (window.length) {
          const flags = await client.fetchAll(window, { uid: true, flags: true }, { uid: true });
          const changed = flags.flatMap(meta => {
            try {
              const m = this.store.get(`${encodeURIComponent(this.credentials!.username)}:INBOX:${validity}:${meta.uid}`);
              const unread = !meta.flags?.has('\\Seen');
              return m.unread === unread ? [] : [{ ...m, unread }];
            } catch { return []; }
          });
          if (changed.length) this.store.commitBatch(this.credentials!.username, validity, changed, highest);
        }
      }
      this.status = { ...this.status, state: 'online', message: 'Connected. Inbox is read-only.', lastSync: new Date().toISOString() };
      this.failures = 0;
      this.changed();
      if (!this.reconcile) this.reconcile = setInterval(() => { void this.refresh(); }, 60_000);
      if (high > 0 && (candidates.length > uids.length || rangeUpper < upper)) {
        if (!uids.length && rangeUpper < upper) this.store.commitBatch(this.credentials!.username, validity, [], rangeUpper);
        this.dirty = true;
      }
    } finally { lock.release(); }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.reconcile); this.client?.close(); }
}
