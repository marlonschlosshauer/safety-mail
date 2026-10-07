import type { Assessment, Finding, MailMessage } from '../shared/types.js';

export function normalizeLink(value: string): { url: string; hostname: string; blocked: boolean } {
  try {
    const url = new URL(value);
    const blocked = !['https:', 'http:'].includes(url.protocol) || !!url.username || !!url.password || value.length > 4096;
    return { url: url.href, hostname: url.hostname, blocked };
  } catch { return { url: value.slice(0, 4096), hostname: '', blocked: true }; }
}

export function screenLocally(message: Pick<MailMessage, 'senderName' | 'senderAddress' | 'replyTo' | 'subject' | 'body' | 'links' | 'attachments'>): Assessment {
  const findings: Finding[] = [];
  const add = (code: string, text: string, severity: Finding['severity'] = 'review') => {
    if (!findings.some(f => f.code === code)) findings.push({ code, text, severity });
  };
  if (message.replyTo && message.replyTo.toLowerCase() !== message.senderAddress.toLowerCase())
    add('reply_mismatch', 'Replies go to a different address than the sender.');
  const senderDomain = message.senderAddress.split('@').at(-1)?.toLowerCase() ?? '';
  const providerDomain = (domain: string) => ['t-online.de', 'telekom.de'].some(trusted => domain === trusted || domain.endsWith(`.${trusted}`));
  if (/(t[ -]?online|telekom)/i.test(message.senderName) && !providerDomain(senderDomain))
    add('provider_impersonation', 'The sender’s name suggests T-Online or Telekom, but its address uses a different domain.');
  if (senderDomain.includes('xn--') || /[^\x00-\x7f]/.test(senderDomain))
    add('sender_domain', 'The sender’s address uses an international domain. Check its spelling carefully.');
  for (const link of message.links) {
    if (link.blocked) add('blocked_scheme', 'A link uses an unsupported destination and cannot be opened.', 'high');
    const host = link.hostname.toLowerCase();
    if (host.includes('xn--')) add('encoded_domain', 'A link has an encoded international domain. Check the spelling carefully.');
    if (/t[ -]?onl[i1]ne|telekom/i.test(host) && !providerDomain(host))
      add('lookalike_domain', 'A website address resembles T-Online or Telekom but is on a different domain.');
    try {
      if ([...new URL(link.url).searchParams.keys()].some(key => /^(url|redirect|redirect_uri|redirect_url|next|target|dest|destination)$/i.test(key)))
        add('redirect', 'A link may redirect to another destination after it opens.');
    } catch { /* Invalid URLs are blocked separately. */ }
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('['))
      add('ip_link', 'A link goes to a numeric address instead of a named website.');
    if (['bit.ly', 'tinyurl.com', 't.co', 'shorturl.at'].includes(host))
      add('short_link', 'A shortened link hides the final destination.');
    const visible = link.label.trim();
    if (/^(https?:\/\/|www\.)/i.test(visible)) {
      const display = normalizeLink(visible.startsWith('www.') ? `https://${visible}` : visible);
      if (display.hostname && display.hostname !== host)
        add('deceptive_link', 'The website written in a link differs from its actual destination.', 'high');
    }
    if (link.url.startsWith('http:')) add('unencrypted_link', 'A link uses an unencrypted HTTP connection.');
  }
  const text = `${message.subject}\n${message.body}`;
  if (/(password|passwort|security code|verification code|pin code|login|log in|anmelden)/i.test(text))
    add('secret_request', 'The message mentions signing in, a password, or a security code.');
  if (/(urgent|immediately|within \d+ hours|account.{0,20}(suspend|block)|sofort|dringend|gesperrt)/i.test(text))
    add('urgency', 'The message pressures you to act quickly.');
  if (/(wire transfer|bank transfer|pay now|payment|überweisung|zahlung)/i.test(text))
    add('payment', 'The message mentions a payment or transfer.');
  for (const a of message.attachments)
    if (/\.(exe|scr|bat|cmd|com|js|vbs|msi|ps1|lnk|iso)$/i.test(a.name) || /\.(pdf|docx?|jpe?g|png)\.[^.]+$/i.test(a.name))
      add('attachment', 'An attachment has a potentially dangerous or misleading file extension.', 'high');
  return { risk: findings.some(f => f.severity === 'high') ? 'high' : findings.length ? 'review' : 'none', findings,
    source: 'local', modelStatus: 'not_configured', rulesVersion: 'poc-1' };
}
