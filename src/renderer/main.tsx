import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LinkReview, MailMessage, MessageSummary, SyncStatus } from '../shared/types.js';
import { api } from './api.js';
import './styles.css';

const labels = { high: 'Strong warning signs', review: 'Needs caution', none: 'Local checks only', not_checked: 'Not checked' };
const symbols = { high: '!', review: '!', none: 'i', not_checked: '?' };
function dateLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}
function RiskBadge({ risk }: { risk: MailMessage['assessment']['risk'] }) {
  return <span className={`risk-badge ${risk}`}><span aria-hidden="true">{symbols[risk]}</span>{labels[risk]}</span>;
}
function App() {
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState<MailMessage>();
  const [status, setStatus] = useState<SyncStatus>();
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [review, setReview] = useState<LinkReview>();
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState('');
  const [large, setLarge] = useState(() => localStorage.getItem('clear-mail-large') !== 'false');
  const [contrast, setContrast] = useState(() => localStorage.getItem('clear-mail-contrast') === 'true');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const readerRef = useRef<HTMLHeadingElement>(null);
  const focusAfterLoad = useRef(false);
  const selection = useRef(0);
  const seenIds = useRef(new Set<string>());
  const currentId = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      const [page, state] = await Promise.all([api.listMessages({ limit: 100 }), api.getSyncStatus()]);
      const added = page.messages.filter(m => !seenIds.current.has(m.id));
      if (seenIds.current.size && added.length) setAnnouncement(`${added.length} new message${added.length === 1 ? '' : 's'} in your inbox.`);
      seenIds.current = new Set(page.messages.map(m => m.id));
      setMessages(page.messages); setNextCursor(page.nextCursor); setStatus(state);
      setSelectedId(id => page.messages.some(m => m.id === id) ? id : page.messages[0]?.id);
    } catch { setError('The inbox could not be loaded. Try refreshing.'); }
  }, []);
  useEffect(() => { void load(); return api.onChanged(() => { void load(); }); }, [load]);
  useEffect(() => {
    document.documentElement.classList.toggle('large-text', large);
    document.documentElement.classList.toggle('high-contrast', contrast);
    localStorage.setItem('clear-mail-large', String(large)); localStorage.setItem('clear-mail-contrast', String(contrast));
  }, [large, contrast]);
  useEffect(() => {
    const request = ++selection.current;
    currentId.current = selectedId;
    setMessage(undefined); setAcknowledged(false); setReview(undefined); setError('');
    if (!selectedId) return;
    void api.getMessage(selectedId).then(m => {
      if (request !== selection.current) return;
      setMessage(m);
      if (m.assessment.risk !== 'none') setAnnouncement(`${labels[m.assessment.risk]}. ${m.assessment.findings[0]?.text ?? 'This message has not been checked.'}`);
      if (focusAfterLoad.current) { focusAfterLoad.current = false; requestAnimationFrame(() => readerRef.current?.focus()); }
    }).catch(() => { if (request === selection.current) setError('This message could not be opened. Try another message.'); });
  }, [selectedId]);
  useEffect(() => { if (review) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [review]);
  async function refresh() {
    setRefreshing(true); setError('');
    try { await api.refreshInbox(); await load(); setAnnouncement('Inbox refreshed.'); }
    catch { setError('Refresh failed. Cached messages are still available.'); }
    finally { setRefreshing(false); }
  }
  async function reviewLink(linkId: string) {
    if (!message) return;
    const id = message.id;
    try {
      const result = await api.prepareExternalLink({ messageId: id, linkId });
      if (currentId.current === id) setReview(result);
    } catch { setError('This link cannot be opened.'); }
  }
  async function openLink() {
    if (!review) return;
    setOpening(true);
    try { await api.openExternalLink({ token: review.token, acknowledgedRisk: acknowledged }); }
    catch (e) { setError(window.mailApi ? 'The link could not be opened. Review its destination again.' : (e as Error).message); }
    finally { setOpening(false); setReview(undefined); }
  }
  async function loadMore() {
    if (!nextCursor) return;
    try {
      const page = await api.listMessages({ cursor: nextCursor, limit: 100 });
      setMessages(previous => [...previous, ...page.messages.filter(m => !previous.some(p => p.id === m.id))]);
      setNextCursor(page.nextCursor);
    } catch { setError('More messages could not be loaded. Try again.'); }
  }
  const visible = messages.filter(m => `${m.subject} ${m.senderName} ${m.senderAddress}`.toLowerCase().includes(query.toLowerCase()));
  const needsCaution = message?.assessment.risk !== 'none';
  return <>
    <a className="skip-link" href="#message-title">Skip to message</a>
    <header className="app-header">
      <div className="brand"><span className="brand-icon" aria-hidden="true">✉</span><span>Clear Mail<small>A little more clarity. A little more care.</small></span></div>
      <div className="preferences" aria-label="Reading preferences">
        <button aria-pressed={large} onClick={() => setLarge(!large)}>Aa <span>Larger text</span></button>
        <button aria-pressed={contrast} onClick={() => setContrast(!contrast)}><span aria-hidden="true">◐</span> High contrast</button>
      </div>
    </header>
    <div className="status-bar"><span className={`status-dot ${status?.state}`} aria-hidden="true"/><span>{status?.message ?? 'Loading your inbox…'}</span>{status?.mode === 'demo' && <span className="demo-label">DEMO</span>}</div>
    <div className="live-region" role="status" aria-live="polite">{announcement}</div>
    {error && <div className="error" role="alert">{error}</div>}
    <main className="mail-layout">
      <section className="inbox" aria-labelledby="inbox-title">
        <div className="inbox-heading"><div><p className="eyebrow">YOUR MAIL</p><h1 id="inbox-title">Inbox <span>{messages.length}</span></h1></div><button className="refresh" disabled={refreshing} onClick={() => { void refresh(); }}><span aria-hidden="true">↻</span> {refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
        <p className="account">{status?.account ?? 'Take a moment. Read at your own pace.'}</p>
        <label className="search-label" htmlFor="search">Find a message</label>
        <input id="search" type="search" placeholder="Sender or subject" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="message-list" aria-label="Inbox messages">
          {visible.map(m => <button className={`message-row ${selectedId === m.id ? 'selected' : ''}`} key={m.id}
            aria-current={selectedId === m.id ? 'true' : undefined}
            onClick={() => { focusAfterLoad.current = true; if (selectedId === m.id) readerRef.current?.focus(); else setSelectedId(m.id); }}>
            <span className="row-meta"><span className="sender">{m.unread && <span className="unread-dot" aria-hidden="true"/>}{m.senderName}</span><time dateTime={m.date}>{dateLabel(m.date)}</time></span>
            <span className="row-subject">{m.subject}</span>
            <span className="row-footer"><RiskBadge risk={m.assessment.risk} />{m.unread && <span className="unread-label">Unread</span>}</span>
          </button>)}
          {!visible.length && <p className="empty">{query ? 'No messages match your search.' : 'No cached messages yet.'}</p>}
          {nextCursor && <button className="load-more" onClick={() => { void loadMore(); }}>Load older messages</button>}
        </div>
        <aside className="inbox-note"><span aria-hidden="true">◇</span><p>Your inbox stays as it is.<br/><span>Reading here never marks mail as read on the server.</span></p></aside>
      </section>
      <section className="reader" aria-label="Message reader">
        {!message ? <div className="reader-empty"><h2 id="message-title" tabIndex={-1} ref={readerRef}>{selectedId ? 'Loading message…' : 'Your reading space'}</h2><p>{selectedId ? 'One moment.' : 'Choose a message from your inbox.'}</p></div> : <>
          <div className="reader-top"><span className="eyebrow">MESSAGE</span><span className="plain-label">Plain text · remote content blocked</span></div>
          <h2 id="message-title" tabIndex={-1} ref={readerRef}>{message.subject}</h2>
          <div className="sender-details"><span className="avatar" aria-hidden="true">{message.senderName.charAt(0).toUpperCase()}</span><div><strong>{message.senderName}</strong><div className="address"><bdi>{message.senderAddress}</bdi></div></div></div>
          <div className="message-date"><time dateTime={message.date}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(message.date))}</time>{message.replyTo && <span>Reply address: <bdi>{message.replyTo}</bdi></span>}</div>
          <div className={`warning ${message.assessment.risk}`}>
            <span className="warning-icon" aria-hidden="true">{symbols[message.assessment.risk]}</span>
            <div><h3>{message.assessment.risk === 'high' ? 'Pause before acting' : message.assessment.risk === 'review' ? 'Read this message with care' : message.assessment.risk === 'not_checked' ? 'This message has not been checked' : 'No obvious warning signs found'}</h3>
              {message.assessment.risk === 'none' ? <p>Local checks are limited. Be careful with requests for passwords or money.</p> : message.assessment.risk === 'not_checked' ? <p>We cannot assess this message. Be careful with its links and requests.</p> : <><p>{labels[message.assessment.risk]}. Take your time and check with the sender another way.</p><ul>{message.assessment.findings.map(f => <li key={f.code}>{f.text}</li>)}</ul></>}
              <small>{message.assessment.risk === 'not_checked' ? 'Screening unavailable.' : 'Local checks only.'} AI screening is not enabled.</small>
            </div>
          </div>
          <div className="message-body">{message.body}</div>
          {message.attachments.length > 0 && <section className="attachments" aria-label="Attachments"><h3>Attachments</h3>{message.attachments.map((a, i) => <p key={i}>▤ {a.name} <span>({Math.ceil(a.size / 1024)} KB) · Opening unavailable</span></p>)}</section>}
          {message.links.length > 0 && <section className="links" aria-labelledby="links-title"><h3 id="links-title">Links in this message</h3><p>Check the actual website before deciding to open it.</p>
            {needsCaution && <label className="acknowledge"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I have read the warning and understand that these links may be risky.</label>}
            {message.links.map(link => <div className="link-card" key={link.id}><div><span className="link-caption">{link.label}</span><span className="destination">Actual website: <bdi>{link.hostname || 'Unsupported destination'}</bdi></span></div><button disabled={link.blocked || (needsCaution && !acknowledged)} onClick={() => { void reviewLink(link.id); }}>{link.blocked ? 'Blocked link' : 'Review link'} <span aria-hidden="true">↗</span></button></div>)}
          </section>}
          <footer className="reader-footer">Receive-only · No replies, deletion, or attachment opening</footer>
        </>}
      </section>
    </main>
    <dialog ref={dialogRef} className="link-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description" onCancel={() => setReview(undefined)} onClose={() => setReview(undefined)}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <p className="eyebrow">BEFORE YOU LEAVE YOUR INBOX</p><h2 id="dialog-title">Check this destination</h2>
      <p id="dialog-description">This link leads to the website below. Check the address carefully.</p>
      <div className="dialog-destination"><span>ACTUAL WEBSITE</span><strong><bdi>{review?.hostname}</bdi></strong><code dir="ltr">{review?.url}</code></div>
      {review?.risk !== 'none' && <p className="dialog-warning">This message needs caution. If you are unsure, stay in your inbox.</p>}
      <div className="dialog-actions"><button autoFocus onClick={() => setReview(undefined)}>Stay in mail</button><button className="primary" disabled={opening} onClick={() => { void openLink(); }}>{opening ? 'Opening…' : 'Continue to website'}</button></div>
    </dialog>
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
