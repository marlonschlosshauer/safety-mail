import type { MailMessage } from './types.js';
export const demoMessages: MailMessage[] = [
  {
    id: 'demo:INBOX:1:3', uid: 3, senderName: 'Account Support', senderAddress: 'support@account-check.example',
    replyTo: 'verify@different-address.example', subject: 'Urgent: confirm your account today',
    date: '2026-10-07T09:15:00.000Z', unread: true,
    body: 'Dear customer,\n\nYour account will be suspended within 24 hours. Log in and confirm your password to keep access.\n\nConfirm your account using the link below.\n\nAccount Support\n\nThis is a fictional example for testing warnings.',
    links: [{ id: '0', label: 'https://www.t-online.de', url: 'https://account-check.example/login', hostname: 'account-check.example', blocked: false }],
    attachments: [], assessment: { risk: 'high', findings: [
      { code: 'deceptive_link', text: 'The website written in a link differs from its actual destination.', severity: 'high' },
      { code: 'reply_mismatch', text: 'Replies go to a different address than the sender.', severity: 'review' },
      { code: 'secret_request', text: 'The message mentions signing in, a password, or a security code.', severity: 'review' },
      { code: 'urgency', text: 'The message pressures you to act quickly.', severity: 'review' },
    ], source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' },
  },
  {
    id: 'demo:INBOX:1:2', uid: 2, senderName: 'Anna', senderAddress: 'anna@example.com',
    subject: 'Coffee on Saturday?', date: '2026-10-07T08:30:00.000Z', unread: true,
    body: 'Hello!\n\nWould you like to meet for coffee on Saturday? I can come by at ten, and we can walk to the café together.\n\nLet me know when we next talk.\n\nLove,\nAnna\n\nThis is a fictional example message.',
    links: [], attachments: [], assessment: { risk: 'none', findings: [], source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' },
  },
  {
    id: 'demo:INBOX:1:1', uid: 1, senderName: 'Community Library', senderAddress: 'news@example.org',
    subject: 'Your monthly reading list', date: '2026-10-06T12:00:00.000Z', unread: false,
    body: 'Hello,\n\nYour new reading list is ready. This month includes a collection of short stories and our favourite autumn recipes.\n\nAn attachment is listed below. Attachment opening is not available in this prototype.\n\nCommunity Library\n\nThis message has intentionally not been checked, so you can try that state.',
    links: [{ id: '0', label: 'Visit the library website', url: 'https://example.org/reading', hostname: 'example.org', blocked: false }],
    attachments: [{ name: 'reading-list.pdf', size: 48000, contentType: 'application/pdf' }],
    assessment: { risk: 'not_checked', findings: [], source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' },
  },
];
