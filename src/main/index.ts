import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MailStore } from './store.js';
import { InboxSync } from './sync.js';
import { loadCredentials } from './credentials.js';
import { LinkGate } from './link-gate.js';
import { demoMessages } from '../shared/demo.js';
import type { SyncStatus } from '../shared/types.js';

app.setName('Clear Mail');
let sync: InboxSync | undefined;
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => sync?.stop());

async function start() {
await app.whenReady();
const directory = app.getPath('userData');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const live = process.env.MAIL_MODE === 'live';
const loaded = live ? await loadCredentials(directory) : {};
delete process.env.MAIL_USERNAME;
delete process.env.MAIL_PASSWORD;
delete process.env.MAIL_REMEMBER;
const accountPath = join(directory, 'account.json');
let cachedAccount: string | undefined;
try { if (existsSync(accountPath)) cachedAccount = z.email().parse(JSON.parse(readFileSync(accountPath, 'utf8'))); } catch { /* Invalid metadata is not used. */ }
const account = loaded.credentials?.username ?? cachedAccount;
if (live && loaded.credentials) writeFileSync(accountPath, JSON.stringify(account), { mode: 0o600 });
const cacheName = live ? `inbox-${createHash('sha256').update(account ?? 'unconfigured').digest('hex').slice(0, 24)}.sqlite` : 'demo.sqlite';
const store = await MailStore.open(join(directory, cacheName));
const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(here, '../renderer/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const window = new BrowserWindow({ width: 1400, height: 1000, minWidth: 880, minHeight: 680,
  title: 'Clear Mail', backgroundColor: '#f7f6f2', autoHideMenuBar: true,
  webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true },
});
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => { event.preventDefault(); });
window.webContents.on('will-attach-webview', event => { event.preventDefault(); });
window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
window.webContents.session.setPermissionCheckHandler(() => false);
// No renderer networking, including remote email resources. Only bundled assets are allowed.
window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: !details.url.startsWith(pathToFileURL(join(here, '../renderer/')).href) });
});
const notify = () => { if (!window.isDestroyed()) window.webContents.send('mail:changed'); };
let credentialNote: string | undefined;
if (live) {
  credentialNote = loaded.note;
  sync = new InboxSync(store, loaded.credentials, notify);
  sync.status.account = account;
} else {
  store.commitBatch('demo', '1', demoMessages, 3);
}
const gate = new LinkGate(store);
function handle<T>(channel: string, schema: z.ZodType<T>, callback: (input: T) => unknown) {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl)
      throw new Error('This operation is not available from this page.');
    const result = schema.safeParse(raw);
    if (!result.success) throw new Error('Invalid request.');
    return callback(result.data);
  });
}
handle('mail:list', z.object({ cursor: z.string().regex(/^\d{1,8}$/).optional(), limit: z.number().int().min(1).max(100) }).strict(), input => store.list(input));
handle('mail:get', z.string().min(1).max(1000), id => store.get(id));
handle('mail:refresh', z.undefined(), () => sync?.refresh());
handle('mail:status', z.undefined(), (): SyncStatus => sync ? { ...sync.status, message: credentialNote ? `${sync.status.message} ${credentialNote}` : sync.status.message }
  : { mode: 'demo', state: 'demo', message: 'Demo inbox · fictional messages · no account connected' });
handle('mail:prepare-link', z.object({ messageId: z.string().max(1000), linkId: z.string().max(100) }).strict(), input => gate.prepare(input.messageId, input.linkId));
handle('mail:open-link', z.object({ token: z.uuid(), acknowledgedRisk: z.boolean() }).strict(), async input => {
  const review = gate.consume(input.token, input.acknowledgedRisk);
  // Native confirmation keeps the final opening decision in the privileged process.
  const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Open this website?',
    message: `Actual destination: ${review.hostname}`, detail: `${review.url}\n\n${review.risk === 'none' ? 'Local checks cannot guarantee this website is trustworthy.' : 'This message needs caution. Only continue if you intended to visit this website.'}`,
    buttons: ['Stay in mail', 'Open website'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response === 1) await shell.openExternal(review.url);
});
await window.loadFile(rendererPath);
void sync?.refresh();
}
void start().catch(() => {
  dialog.showErrorBox('Clear Mail could not start', 'The local inbox could not be opened. Check that your application data folder is writable.');
  app.quit();
});
