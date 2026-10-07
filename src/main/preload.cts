import { contextBridge, ipcRenderer } from 'electron';
import type { MailApi } from '../shared/types.js';
const api: MailApi = {
  listMessages: input => ipcRenderer.invoke('mail:list', input),
  getMessage: id => ipcRenderer.invoke('mail:get', id),
  refreshInbox: () => ipcRenderer.invoke('mail:refresh'),
  getSyncStatus: () => ipcRenderer.invoke('mail:status'),
  prepareExternalLink: input => ipcRenderer.invoke('mail:prepare-link', input),
  openExternalLink: input => ipcRenderer.invoke('mail:open-link', input),
  onChanged: listener => {
    const handler = () => listener();
    ipcRenderer.on('mail:changed', handler);
    return () => ipcRenderer.removeListener('mail:changed', handler);
  },
};
contextBridge.exposeInMainWorld('mailApi', api);
