import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { MailStore } from '../src/main/store.js';

const data = vi.hoisted(() => ({ uids: [5, 12], validity: 1n, clients: [] as unknown[], fetches: [] as number[], failDownload: false, failConnect: false }));
vi.mock('imapflow', () => ({ ImapFlow: class extends EventEmitter {
  mailbox = { uidValidity: data.validity, uidNext: Math.max(...data.uids, 0) + 1, exists: data.uids.length };
  usable = true;
  options: unknown;
  constructor(options: unknown) { super(); this.options = options; data.clients.push(this); }
  async connect() { if (data.failConnect) throw new Error('Authentication failed with confidential server detail'); }
  async getMailboxLock(_path: string, options: unknown) { expect(options).toEqual({ readOnly: true }); return { release() {} }; }
  async search(query: { all?: boolean; uid?: string }, options: unknown) {
    expect(options).toEqual({ uid: true });
    if (query.all) return data.uids;
    const [lo, hi] = query.uid!.split(':').map(Number); return data.uids.filter(uid => uid >= lo && uid <= hi);
  }
  async fetchOne(uid: string, _query: unknown, options: unknown) {
    expect(options).toEqual({ uid: true }); data.fetches.push(Number(uid));
    return { uid: Number(uid), flags: new Set(), size: 200, envelope: { subject: `Message ${uid}` } };
  }
  async download(uid: string, _part: unknown, options: unknown) {
    expect(options).toEqual({ uid: true });
    if (data.failDownload) { this.usable = false; throw new Error('Socket lost'); }
    return { content: Readable.from([`From: Anna <anna@example.com>\r\nSubject: Message ${uid}\r\n\r\nHello!`]) };
  }
  async fetchAll(uids: number[], _query: unknown, options: unknown) { expect(options).toEqual({ uid: true }); return uids.map(uid => ({ uid, flags: new Set() })); }
  close() { if (this.usable) { this.usable = false; this.emit('close'); } }
} }));
import { InboxSync } from '../src/main/sync.js';

afterEach(() => {
  data.uids = [5, 12]; data.validity = 1n; data.clients = []; data.fetches = []; data.failDownload = false; data.failConnect = false;
  vi.useRealTimers();
});
describe('read-only synchronization', () => {
  it('uses UID keys, catches up after restart, and invalidates changed UIDVALIDITY', async () => {
    const store = await MailStore.open();
    const credentials = { username: 'test@t-online.de', password: 'session-only' };
    let sync = new InboxSync(store, credentials, () => {});
    await sync.refresh(); sync.stop();
    expect(store.cursor(credentials.username)).toEqual({ validity: '1', highest: 12 });
    expect(store.list({ limit: 100 }).messages).toHaveLength(2);
    data.uids = [5, 12, 20];
    sync = new InboxSync(store, credentials, () => {});
    await sync.refresh(); sync.stop();
    expect(data.fetches).toEqual([5, 12, 20]);
    expect(store.list({ limit: 100 }).messages).toHaveLength(3);
    data.validity = 2n; data.uids = [5];
    sync = new InboxSync(store, credentials, () => {});
    await sync.refresh(); sync.stop();
    expect(store.list({ limit: 100 }).messages).toHaveLength(1);
    expect(store.cursor(credentials.username)?.validity).toBe('2');
    expect((data.clients[0] as { options: unknown }).options).toMatchObject({ host: 'secureimap.t-online.de', port: 993, secure: true, logger: false });
    store.close();
  });
  it('does not advance the UID cursor when download fails', async () => {
    const store = await MailStore.open(); data.failDownload = true;
    const sync = new InboxSync(store, { username: 'test@t-online.de', password: 'hidden' }, () => {});
    await sync.refresh();
    expect(store.cursor('test@t-online.de')).toBeUndefined();
    expect(sync.status.state).toBe('offline');
    expect(JSON.stringify(sync.status)).not.toContain('hidden');
    sync.stop(); store.close();
  });
  it('keeps reconnecting after repeated failures and later catches up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const store = await MailStore.open(); data.failConnect = true;
    const sync = new InboxSync(store, { username: 'test@t-online.de', password: 'hidden' }, () => {});
    await sync.refresh();
    expect(data.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(data.clients).toHaveLength(2);
    data.failConnect = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(data.clients).toHaveLength(3);
    await sync.refresh();
    expect(sync.status.state).toBe('online');
    expect(store.list({ limit: 100 }).messages).toHaveLength(2);
    sync.stop(); store.close(); vi.restoreAllMocks();
  });
  it('limits an initial inbox to the latest 100 messages', async () => {
    const store = await MailStore.open(); data.uids = Array.from({ length: 150 }, (_v, i) => i + 1);
    const sync = new InboxSync(store, { username: 'test@t-online.de', password: 'hidden' }, () => {});
    await sync.refresh(); sync.stop();
    expect(data.fetches).toHaveLength(100); expect(data.fetches[0]).toBe(51);
    expect(store.cursor('test@t-online.de')?.highest).toBe(150); store.close();
  });
});
