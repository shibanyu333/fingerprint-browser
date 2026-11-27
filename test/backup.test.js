import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '../web/backup.js';

test('encrypted backups preserve credentials and reject an incorrect password or modified ciphertext', async () => {
  const data = { version: 1, proxies: [{ id: 'sample', password: 'fixture-only' }], profiles: [] };
  const password = 'temporary-backup-passphrase';
  const first = await encryptBackup(data, password);
  const second = await encryptBackup(data, password);
  assert.equal(isEncryptedBackup(data), false);
  assert.equal(isEncryptedBackup(first), true);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.deepEqual(await decryptBackup(first, password), data);
  await assert.rejects(decryptBackup(first, 'wrong-password'), /密码错误或文件已损坏/);

  const bytes = Buffer.from(first.ciphertext, 'base64');
  bytes[0] ^= 1;
  const tampered = { ...first, ciphertext: bytes.toString('base64') };
  await assert.rejects(decryptBackup(tampered, password), /密码错误或文件已损坏/);
});
