// The passphrase that encrypts backups of live data (scripts/lib/backup-crypto.mjs).
//
//   node scripts/backup-key.mjs --init                 create it (once; never overwrites)
//   node scripts/backup-key.mjs --status               is it there, owner-only?
//   node scripts/backup-key.mjs --encrypt <backup.json> [--remove-plaintext]
//        encrypt an older plaintext backup to <backup.json>.gpg, check it
//        decrypts to the identical bytes, and (with --remove-plaintext) then
//        overwrite and delete the plaintext file
//   node scripts/backup-key.mjs --verify <backup.json.gpg>
//        decrypt in memory; print its sha256 and document count
//
// Prints paths, hashes and counts only, never the passphrase or the data.
// To see the passphrase (to store it in a password manager), read the file
// yourself: cat ~/.config/buildpro-plus/backup-passphrase
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { KEY_FILE, decrypt, hasKey, initKey, readBackupFile, writeBackupFile } from './lib/backup-crypto.mjs'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const sha = (s) => createHash('sha256').update(s).digest('hex')
const count = (text) => {
  const j = JSON.parse(text)
  return Array.isArray(j.documents) ? `${j.documents.length} documents` : Array.isArray(j.entries) ? `${j.entries.length} entries` : 'unknown shape'
}

if (args.includes('--init')) {
  console.log(initKey() ? `Created ${KEY_FILE} (owner-only). Copy it to a password manager: without it, encrypted backups cannot be read.` : `${KEY_FILE} already exists; left as is.`)
} else if (args.includes('--status')) {
  if (!hasKey()) { console.log(`No passphrase at ${KEY_FILE}.`); process.exit(1) }
  const mode = (statSync(KEY_FILE).mode & 0o777).toString(8)
  console.log(`${KEY_FILE}: present, mode ${mode}${mode === '600' || mode === '400' ? ' (owner-only)' : ' (NOT owner-only: chmod 600 it)'}`)
} else if (value('--encrypt')) {
  const file = value('--encrypt')
  if (file.endsWith('.gpg')) { console.error('Already encrypted.'); process.exit(2) }
  const text = readFileSync(file, 'utf8')
  const out = writeBackupFile(file, text, { requireEncryption: true })
  const back = decrypt(readFileSync(out))
  if (back !== text) { console.error(`${out} does not decrypt to the original; plaintext kept.`); process.exit(1) }
  console.log(`Encrypted ${file}\n     -> ${out}\n  sha256 of the content ${sha(text)} (same after decrypting), ${count(text)}`)
  if (args.includes('--remove-plaintext')) {
    // Overwrite the plaintext's blocks before unlinking it (best effort on
    // ext4; journaling may keep old copies, which is why new backups are
    // encrypted before they ever touch the disk).
    const r = spawnSync('shred', ['--iterations=1', '--zero', '--remove', file])
    if (r.status !== 0) unlinkSync(file)
    console.log(existsSync(file) ? `  could not remove ${file}` : `  plaintext overwritten and removed`)
  }
} else if (value('--verify')) {
  const text = readBackupFile(value('--verify'))
  console.log(`${value('--verify')}: decrypts; sha256 of the content ${sha(text)}, ${count(text)}`)
} else {
  console.error('Usage: --init | --status | --encrypt <backup.json> [--remove-plaintext] | --verify <backup.json.gpg>')
  process.exit(2)
}
