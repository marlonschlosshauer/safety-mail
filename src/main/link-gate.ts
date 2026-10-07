import { randomUUID } from 'node:crypto';
import type { MailStore } from './store.js';
import type { LinkReview } from '../shared/types.js';
import { normalizeLink } from './screening.js';

export class LinkGate {
  private pending = new Map<string, { review: LinkReview; messageId: string; linkId: string; expires: number }>();
  constructor(private store: Pick<MailStore, 'get'>, private now = () => Date.now()) {}
  prepare(messageId: string, linkId: string): LinkReview {
    const message = this.store.get(messageId);
    const link = message.links.find(l => l.id === linkId);
    if (!link) throw new Error('This link is no longer available.');
    const destination = normalizeLink(link.url);
    if (link.blocked || destination.blocked) throw new Error('This type of link cannot be opened.');
    const review: LinkReview = { token: randomUUID(), ...destination, risk: message.assessment.risk };
    for (const [token, value] of this.pending) if (value.expires < this.now()) this.pending.delete(token);
    if (this.pending.size >= 20) this.pending.clear();
    this.pending.set(review.token, { review, messageId, linkId, expires: this.now() + 120_000 });
    return review;
  }
  consume(token: string, acknowledgedRisk: boolean): LinkReview {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.expires < this.now()) throw new Error('This confirmation expired. Review the link again.');
    const current = this.store.get(pending.messageId);
    const link = current.links.find(l => l.id === pending.linkId);
    if (!link || link.blocked || normalizeLink(link.url).blocked || normalizeLink(link.url).url !== pending.review.url)
      throw new Error('This link has changed. Review it again.');
    if (current.assessment.risk !== 'none' && !acknowledgedRisk)
      throw new Error('Acknowledge the message warning before opening a link.');
    return { ...pending.review, risk: current.assessment.risk };
  }
}
