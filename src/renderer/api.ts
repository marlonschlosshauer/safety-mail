import type { MailApi, MailMessage, LinkReview } from '../shared/types.js';
import { demoMessages } from '../shared/demo.js';
declare global { interface Window { mailApi?: MailApi } }

// Browser preview runs on fictional fixtures only. It has no mail or credential access.
const browserDemo: MailApi = {
  async listMessages() { return { messages: demoMessages }; },
  async getMessage(id): Promise<MailMessage> {
    const message = demoMessages.find(m => m.id === id);
    if (!message) throw new Error('Message not found.');
    return message;
  },
  async refreshInbox() {},
  async getSyncStatus() { return { mode: 'demo', state: 'demo', message: 'Browser preview · fictional messages · no account connected' }; },
  async prepareExternalLink({ messageId, linkId }): Promise<LinkReview> {
    const message = demoMessages.find(m => m.id === messageId);
    const link = message?.links.find(l => l.id === linkId);
    if (!message || !link || link.blocked) throw new Error('This link cannot be opened.');
    return { token: 'preview', url: link.url, hostname: link.hostname, blocked: link.blocked, risk: message.assessment.risk };
  },
  async openExternalLink() { throw new Error('The browser preview does not launch websites. Use the desktop app to try this action.'); },
  onChanged() { return () => {}; },
};
export const api = window.mailApi ?? browserDemo;
