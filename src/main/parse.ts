import { MailParser } from 'mailparser';
import { load } from 'cheerio';
import { Readable } from 'node:stream';
import type { MailMessage, MailLink } from '../shared/types.js';
import { normalizeLink, screenLocally } from './screening.js';

export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_BODY_CHARS = 100_000;
export const MAX_LINKS = 100;

export function messageId(account: string, validity: string, uid: number) {
  return `${encodeURIComponent(account)}:INBOX:${validity}:${uid}`;
}
export function extractLinks(text: string, html: string): MailLink[] {
  const links: MailLink[] = [];
  const add = (label: string, raw: string) => {
    if (links.length >= MAX_LINKS || links.some(l => l.label === label && l.url === normalizeLink(raw).url)) return;
    links.push({ id: String(links.length), label: label.slice(0, 500), ...normalizeLink(raw) });
  };
  // Cheerio parses inertly in the main process. HTML is never passed to the renderer.
  if (html) {
    const $ = load(html);
    $('a[href]').each((_i, element) => { add($(element).text().trim() || 'Unlabelled link', $(element).attr('href') ?? ''); });
    $('form').each(() => { add('Email form (blocked)', 'blocked:email-form'); });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0].replace(/[.,;!?)]+$/, '');
    if (!links.some(l => l.url === normalizeLink(url).url)) add(url, url);
  }
  return links;
}

export async function parseMessage(source: Readable, input: { account: string; validity: string; uid: number; unread: boolean; date?: Date }): Promise<MailMessage> {
  const parser = new MailParser({ skipHtmlToText: true, skipTextToHtml: true, maxHtmlLengthToParse: MAX_BODY_CHARS });
  let total = 0;
  let mimeParts = 0;
  let trailing = '';
  let text = '';
  let html = '';
  let headers = new Map<string, unknown>();
  const attachments: MailMessage['attachments'] = [];
  const parseDone = new Promise<void>((resolve, reject) => {
    parser.on('headers', value => { headers = value; });
    parser.on('data', part => {
      if (part.type === 'attachment') {
        const meta = { name: String(part.filename || 'Unnamed attachment').slice(0, 300), size: 0, contentType: part.contentType };
        if (attachments.length < 50) attachments.push(meta);
        part.content.on('data', (chunk: Buffer) => { meta.size += chunk.length; });
        part.content.once('error', reject);
        part.content.once('end', () => part.release());
        part.content.resume(); // Drain and discard bytes; never retain attachment buffers.
      } else { text = (part.text || '').slice(0, MAX_BODY_CHARS); html = String(part.html || '').slice(0, MAX_BODY_CHARS); }
    });
    parser.once('error', reject);
    parser.once('end', resolve);
  });
  // Consume concurrently to enforce a hard byte cap even if the server reports a wrong size.
  const pumping = (async () => {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_MESSAGE_BYTES) throw new Error('Message exceeds the prototype size limit.');
      const sample = trailing + bytes.toString('latin1');
      mimeParts += (sample.match(/(?:^|\r?\n)content-type:\s*multipart\//gi) || []).length;
      trailing = sample.slice(-40).replace(/content-type:/gi, 'counted-type:');
      if (mimeParts > 20) throw new Error('Message has too many nested MIME parts.');
      if (!parser.write(bytes)) await new Promise<void>((resolve, reject) => {
        parser.once('drain', resolve); parser.once('error', reject);
      });
    }
    parser.end();
  })().catch(error => { source.destroy(); parser.destroy(error as Error); throw error; });
  await Promise.all([pumping, parseDone]);
  const address = (key: string) => (headers.get(key) as { value?: { name?: string; address?: string }[] } | undefined)?.value?.[0];
  const from = address('from');
  if (!text && html) {
    const $ = load(html);
    $('script, style, head, iframe, object').remove();
    $('br').replaceWith('\n');
    $('p,div,li,tr,h1,h2,h3').append('\n');
    text = $.root().text().slice(0, MAX_BODY_CHARS);
  }
  const date = headers.get('date');
  const m: MailMessage = {
    id: messageId(input.account, input.validity, input.uid), uid: input.uid,
    senderName: (from?.name || from?.address || 'Unknown sender').slice(0, 300),
    senderAddress: (from?.address || '').slice(0, 500), replyTo: address('reply-to')?.address,
    returnPath: String(headers.get('return-path') || '').slice(0, 500),
    subject: String(headers.get('subject') || '(No subject)').slice(0, 1000),
    date: date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : (input.date ?? new Date()).toISOString(),
    unread: input.unread, body: text || 'This message has no readable text.',
    links: extractLinks(text, html), attachments,
    assessment: { risk: 'not_checked', findings: [], source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' },
  };
  m.assessment = screenLocally(m);
  if (total > MAX_BODY_CHARS || mimeParts > 10 || m.links.length === MAX_LINKS || attachments.length === 50) {
    m.assessment.findings.push({ code: 'limited_content', severity: 'review', text: 'Some content may be omitted by the prototype’s display limits.' });
    if (m.assessment.risk === 'none') m.assessment.risk = 'review';
  }
  return m;
}

export function unavailableMessage(input: { account: string; validity: string; uid: number; unread: boolean; subject?: string; senderName?: string; senderAddress?: string; date?: Date }): MailMessage {
  return {
    id: messageId(input.account, input.validity, input.uid), uid: input.uid,
    senderName: input.senderName || 'Unknown sender', senderAddress: input.senderAddress || '',
    subject: input.subject || '(Message unavailable)', date: (input.date ?? new Date()).toISOString(),
    unread: input.unread, body: 'This message could not be displayed within the prototype’s size or parsing limits.', links: [], attachments: [],
    assessment: { risk: 'not_checked', findings: [], source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' },
  };
}
