import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Credentials } from './sync.js';

const credentialSchema = z.object({ username: z.email().max(320), password: z.string().min(1).max(1024) }).strict();
export async function loadCredentials(directory: string): Promise<{ credentials?: Credentials; note?: string }> {
  const path = join(directory, 'credentials.enc');
  const username = process.env.MAIL_USERNAME;
  const password = process.env.MAIL_PASSWORD;
  const persist = process.env.MAIL_REMEMBER === '1';
  delete process.env.MAIL_PASSWORD;
  delete process.env.MAIL_USERNAME;
  delete process.env.MAIL_REMEMBER;
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
  const encryptedStorage = safeStorage.isEncryptionAvailable() && !['basic_text', 'unknown'].includes(backend);
  if (username || password) {
    const parsed = credentialSchema.safeParse({ username, password });
    if (!parsed.success) return { note: 'Credentials are incomplete. Use a full email address and the email-program password.' };
    if (persist && encryptedStorage) {
      writeFileSync(`${path}.tmp`, await safeStorage.encryptStringAsync(JSON.stringify(parsed.data)), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }
    return { credentials: parsed.data, note: persist && !encryptedStorage ? 'No secure credential store is available. The password is kept for this session only.' : undefined };
  }
  if (existsSync(path) && encryptedStorage) {
    try {
      const { result } = await safeStorage.decryptStringAsync(readFileSync(path));
      return { credentials: credentialSchema.parse(JSON.parse(result)) };
    } catch { return { note: 'Stored credentials could not be unlocked. Enter them again using the launch instructions.' }; }
  }
  return {};
}
