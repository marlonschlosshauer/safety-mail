export type Finding = { code: string; text: string; severity: 'review' | 'high' };
export type Assessment = {
  risk: 'high' | 'review' | 'none' | 'not_checked';
  findings: Finding[];
  source: 'local';
  modelStatus: 'not_configured';
  rulesVersion: 'poc-1';
};
export type MailLink = { id: string; label: string; url: string; hostname: string; blocked: boolean };
export type MailMessage = {
  id: string; uid: number; senderName: string; senderAddress: string;
  replyTo?: string; returnPath?: string; subject: string; date: string;
  unread: boolean; body: string; links: MailLink[];
  attachments: { name: string; size: number; contentType: string }[];
  assessment: Assessment;
};
export type MessageSummary = Omit<MailMessage, 'body' | 'links' | 'attachments' | 'replyTo' | 'returnPath'>;
export type MessageSummaryPage = { messages: MessageSummary[]; nextCursor?: string };
export type SyncStatus = {
  mode: 'demo' | 'live'; state: 'demo' | 'connecting' | 'online' | 'offline' | 'needs_credentials';
  message: string; lastSync?: string; account?: string;
};
export type LinkReview = {
  token: string; url: string; hostname: string; risk: Assessment['risk']; blocked: boolean;
};
export type MailApi = {
  listMessages(input: { cursor?: string; limit: number }): Promise<MessageSummaryPage>;
  getMessage(id: string): Promise<MailMessage>;
  refreshInbox(): Promise<void>;
  getSyncStatus(): Promise<SyncStatus>;
  prepareExternalLink(input: { messageId: string; linkId: string }): Promise<LinkReview>;
  openExternalLink(input: { token: string; acknowledgedRisk: boolean }): Promise<void>;
  onChanged(listener: () => void): () => void;
};
