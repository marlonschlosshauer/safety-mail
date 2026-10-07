import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../src/main/store.js';
import { parseMessage, MAX_MESSAGE_BYTES } from '../src/main/parse.js';
import { normalizeLink, screenLocally } from '../src/main/screening.js';
import { LinkGate } from '../src/main/link-gate.js';
import { demoMessages } from '../src/shared/demo.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
describe('SQLite synchronization invariants', () => {
  it('survives restart, deduplicates by UID, and resets on UIDVALIDITY change', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clear-mail-')); directories.push(directory);
    const path = join(directory, 'mail.sqlite');
    let store = await MailStore.open(path);
    store.commitBatch('demo', '1', demoMessages, 3);
    store.commitBatch('demo', '1', demoMessages, 2);
    store.close(); store = await MailStore.open(path);
    expect(store.list({ limit: 10 }).messages).toHaveLength(3);
    expect(store.cursor('demo')).toEqual({ validity: '1', highest: 3 });
    store.commitBatch('demo', '2', [{ ...demoMessages[0], id: 'demo:INBOX:2:3' }], 3);
    expect(store.list({ limit: 10 }).messages).toHaveLength(1);
    expect(() => store.get(demoMessages[0].id)).toThrow();
    store.close();
  });
  it('does not advance the cursor if persistence fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clear-mail-')); directories.push(directory);
    const path = join(directory, 'mail.sqlite');
    const store = await MailStore.open(path);
    mkdirSync(path); // Simulate a persistence failure after the store is open.
    expect(() => store.commitBatch('demo', '1', demoMessages, 3)).toThrow();
    expect(store.cursor('demo')).toBeUndefined();
    expect(store.list({ limit: 10 }).messages).toHaveLength(0);
    store.close();
  });
  it('paginates without duplicating messages', async () => {
    const store = await MailStore.open();
    store.commitBatch('demo', '1', demoMessages, 3);
    const first = store.list({ limit: 2 });
    const next = store.list({ cursor: first.nextCursor, limit: 2 });
    expect([...first.messages, ...next.messages].map(m => m.id)).toEqual(demoMessages.map(m => m.id));
    expect(next.nextCursor).toBeUndefined(); store.close();
  });
});

describe('untrusted MIME', () => {
  it('extracts deceptive links, strips HTML, and discards attachment contents', async () => {
    const raw = ['From: Account Team <team@example.com>', 'Reply-To: thief@example.net', 'Subject: Urgent login',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '', '--test',
      'Content-Type: text/html; charset=utf-8', '',
      '<script>alert(1)</script><img src="https://tracker.example/pixel"><p>Log in now</p><a href="https://thief.example/login">https://www.t-online.de</a>',
      '--test', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="invoice.pdf.exe"', '',
      'ATTACHMENT-BYTES', '--test--'].join('\r\n');
    const message = await parseMessage(Readable.from([raw]), { account: 'test', validity: '1', uid: 1, unread: true });
    expect(message.body).not.toContain('<script>'); expect(message.body).not.toContain('alert(1)');
    expect(message.body).not.toContain('ATTACHMENT-BYTES');
    expect(message.links[0].hostname).toBe('thief.example');
    expect(message.assessment.risk).toBe('high');
    expect(message.assessment.findings.map(f => f.code)).toContain('deceptive_link');
    expect(message.attachments[0].name).toBe('invoice.pdf.exe');
    expect(Object.keys(message.attachments[0]).sort()).toEqual(['contentType', 'name', 'size']);
  });
  it('rejects oversized streams without retaining their contents', async () => {
    const source = Readable.from([Buffer.alloc(MAX_MESSAGE_BYTES + 1)]);
    await expect(parseMessage(source, { account: 'test', validity: '1', uid: 1, unread: false })).rejects.toThrow('size limit');
  });
  it('bounds multipart complexity', async () => {
    const raw = Array.from({ length: 22 }, () => 'Content-Type: multipart/mixed; boundary=x\r\n').join('');
    await expect(parseMessage(Readable.from([raw]), { account: 'test', validity: '1', uid: 1, unread: false })).rejects.toThrow('MIME parts');
  });
});

describe('destination confirmation', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:password@example.com', 'not a URL'])('blocks %s', value => {
    expect(normalizeLink(value).blocked).toBe(true);
  });
  it('requires acknowledgement, expires confirmations, and rejects reuse', () => {
    let time = 0;
    const gate = new LinkGate({ get: () => demoMessages[0] }, () => time);
    let review = gate.prepare(demoMessages[0].id, '0');
    expect(() => gate.consume(review.token, false)).toThrow('Acknowledge');
    review = gate.prepare(demoMessages[0].id, '0');
    expect(gate.consume(review.token, true).hostname).toBe('account-check.example');
    expect(() => gate.consume(review.token, true)).toThrow('expired');
    review = gate.prepare(demoMessages[0].id, '0'); time = 120_001;
    expect(() => gate.consume(review.token, true)).toThrow('expired');
  });
  it('rejects a changed destination after review', () => {
    const message = structuredClone(demoMessages[0]);
    const gate = new LinkGate({ get: () => message });
    const review = gate.prepare(message.id, '0');
    message.links[0].url = 'https://different.example';
    expect(() => gate.consume(review.token, true)).toThrow('changed');
  });
  it('blocks unchecked messages without acknowledgement', () => {
    const message = demoMessages[2];
    const gate = new LinkGate({ get: () => message });
    const review = gate.prepare(message.id, '0');
    expect(() => gate.consume(review.token, false)).toThrow('Acknowledge');
  });
});

describe('local screening', () => {
  it('does not call ordinary mail safe or imply AI was used', () => {
    const result = screenLocally(demoMessages[1]);
    expect(result.risk).toBe('none'); expect(result.modelStatus).toBe('not_configured');
  });
  it('flags numeric addresses, punycode, and shorteners', () => {
    const message = { ...demoMessages[1], links: ['https://127.0.0.1', 'https://xn--pple-43d.com', 'https://bit.ly/abc']
      .map((url, i) => ({ id: String(i), label: 'Visit', ...normalizeLink(url) })) };
    expect(screenLocally(message).findings.map(f => f.code)).toEqual(expect.arrayContaining(['ip_link', 'encoded_domain', 'short_link']));
  });
});
