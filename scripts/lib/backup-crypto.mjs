// Backups of live customer data are encrypted at rest.
//
// A backup holds everything: customers' names, addresses and phone numbers,
// signatures, the contractor's private notes and markup. On a disk that is
// not itself encrypted, a backup file copied, synced, attached or read by
// another program would hand all of that over. So backups of a live project
// are written encrypted (OpenPGP, AES-256, by the standard `gpg` tool) with a
// random passphrase kept in an owner-only file, and read back transparently.
//
// Decrypting needs nothing from this repo, only gpg and the passphrase:
//   gpg --batch --pinentry-mode loopback --passphrase-file ~/.config/buildpro-plus/backup-passphrase \
//       --decrypt backup.json.gpg > backup.json
// Keep a copy of the passphrase somewhere safe off this machine (a password
// manager): without it the encrypted backups cannot be read.
//
// Emulator and test projects hold no live data; their backups are encrypted
// only when a passphrase exists.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const KEY_FILE = process.env.BUILDPRO_BACKUP_KEY_FILE || join(homedir(), '.config', 'buildpro-plus', 'backup-passphrase')

export const hasKey = () => existsSync(KEY_FILE)

function checkKeyFile() {
  if (!hasKey()) {
    throw new Error(`No backup passphrase at ${KEY_FILE}. Backups of a live project are written encrypted; create one with: node scripts/backup-key.mjs --init`)
  }
  const st = statSync(KEY_FILE)
  if ((st.mode & 0o077) !== 0) throw new Error(`${KEY_FILE} must be readable by its owner only (chmod 600 it).`)
  if (st.size < 32) throw new Error(`${KEY_FILE} is too short to be a backup passphrase.`)
}

// Create the passphrase (random, 256 bits) if there is none. Never overwrites.
export function initKey() {
  if (hasKey()) return false
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
  const fd = openSync(KEY_FILE, 'wx', 0o600)
  writeSync(fd, randomBytes(32).toString('base64url') + '\n')
  fsyncSync(fd)
  closeSync(fd)
  return true
}

function gpg(args, input) {
  checkKeyFile()
  const r = spawnSync('gpg', [
    '--batch', '--quiet', '--no-tty', '--no-symkey-cache', '--pinentry-mode', 'loopback',
    '--passphrase-file', KEY_FILE, ...args,
  ], { input, maxBuffer: 2 ** 31 - 1 })
  if (r.error) throw new Error(`gpg could not run (${r.error.message}); is GnuPG installed?`)
  if (r.status !== 0) throw new Error(`gpg failed: ${String(r.stderr).trim().split('\n').pop()}`)
  return r.stdout
}

export const encrypt = (text) => gpg(['--symmetric', '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512', '--output', '-'], Buffer.from(text, 'utf8'))
export const decrypt = (buf) => gpg(['--decrypt', '--output', '-'], buf).toString('utf8')

export const isEncryptedName = (file) => file.endsWith('.gpg')

// Write a backup (owner-only, never over an existing file). Encrypted when
// `requireEncryption` (a live project) or when a passphrase exists; the
// ciphertext is decrypted again and compared before it is written. Returns
// the path written (with .gpg when encrypted).
export function writeBackupFile(file, text, { requireEncryption }) {
  const enc = requireEncryption || hasKey()
  let data = Buffer.from(text, 'utf8')
  let out = file
  if (enc) {
    data = encrypt(text)
    if (decrypt(data) !== text) throw new Error('Encrypted backup did not decrypt back to the same content; nothing written.')
    out = `${file}.gpg`
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
  const fd = openSync(out, 'wx', 0o600)
  writeSync(fd, data)
  fsyncSync(fd)
  closeSync(fd)
  return out
}

// Read a backup written by writeBackupFile (encrypted or not) as text.
export function readBackupFile(file) {
  const buf = readFileSync(file)
  return isEncryptedName(file) ? decrypt(buf) : buf.toString('utf8')
}
