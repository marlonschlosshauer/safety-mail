import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const profile = mkdtempSync(resolve('work/desktop-test-'));
const containerArgs = process.env.ELECTRON_TEST_CONTAINER === '1' ? ['--no-sandbox', '--disable-gpu'] : [];
const app = await electron.launch({ args: ['.', ...containerArgs], env: { ...process.env,
  MAIL_MODE: 'demo', MAIL_USERNAME: '', MAIL_PASSWORD: '', MAIL_REMEMBER: '',
  XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: join(profile, 'cache') }, timeout: 20000 });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.message-body');
  const boundary = await page.evaluate(() => ({ node: typeof window.require, ipc: typeof window.ipcRenderer, api: Object.keys(window.mailApi).sort() }));
  assert.equal(boundary.node, 'undefined'); assert.equal(boundary.ipc, 'undefined');
  assert.deepEqual(boundary.api, ['getMessage', 'getSyncStatus', 'listMessages', 'onChanged', 'openExternalLink', 'prepareExternalLink', 'refreshInbox']);
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
  await assert.rejects(page.evaluate(() => window.mailApi.listMessages({ limit: 10000 })), /Invalid request/);
  const pending = await page.evaluate(() => window.mailApi.prepareExternalLink({ messageId: 'demo:INBOX:1:3', linkId: '0' }));
  assert.equal(pending.hostname, 'account-check.example');
  await assert.rejects(page.evaluate(token => window.mailApi.openExternalLink({ token, acknowledgedRisk: false }), pending.token), /Acknowledge/);

  await app.evaluate(({ dialog, shell }) => {
    globalThis.linkTest = { nativePrompt: undefined, opened: [], response: 0 };
    dialog.showMessageBox = async (_window, options) => { globalThis.linkTest.nativePrompt = options; return { response: globalThis.linkTest.response, checkboxChecked: false }; };
    shell.openExternal = async url => { globalThis.linkTest.opened.push(url); };
  });
  const cancelled = await page.evaluate(() => window.mailApi.prepareExternalLink({ messageId: 'demo:INBOX:1:3', linkId: '0' }));
  await page.evaluate(token => window.mailApi.openExternalLink({ token, acknowledgedRisk: true }), cancelled.token);
  let result = await app.evaluate(() => globalThis.linkTest);
  assert.match(result.nativePrompt.message, /account-check\.example/); assert.deepEqual(result.opened, []);
  await app.evaluate(() => { globalThis.linkTest.response = 1; });
  const confirmed = await page.evaluate(() => window.mailApi.prepareExternalLink({ messageId: 'demo:INBOX:1:3', linkId: '0' }));
  await page.evaluate(token => window.mailApi.openExternalLink({ token, acknowledgedRisk: true }), confirmed.token);
  result = await app.evaluate(() => globalThis.linkTest);
  assert.deepEqual(result.opened, ['https://account-check.example/login']);
  await assert.rejects(page.evaluate(token => window.mailApi.openExternalLink({ token, acknowledgedRisk: true }), confirmed.token), /expired/);

  // A second renderer using the same preload must still be rejected by sender validation.
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const original = BrowserWindow.getAllWindows()[0];
    const other = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await other.loadURL(original.webContents.getURL());
    globalThis.otherRenderer = other;
  }, resolve('dist/main/preload.cjs'));
  const other = app.windows().find(window => window !== page);
  assert.ok(other);
  await other.waitForFunction(() => !!window.mailApi);
  await assert.rejects(other.evaluate(() => window.mailApi.getSyncStatus()), /not available from this page/);
  await app.evaluate(() => { globalThis.otherRenderer.destroy(); });
  console.log('Desktop checks passed: preload isolation, IPC input/sender validation, acknowledgement, native confirmation, destination integrity, token reuse.');
} finally {
  await app.close(); rmSync(profile, { recursive: true, force: true });
}
