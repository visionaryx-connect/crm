// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with Google Authenticator, 1Password, Authy, etc.
import { randomBytes } from './crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export async function totpAt(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new ArrayBuffer(8)
  const view = new DataView(msg)
  view.setUint32(0, Math.floor(step / 2 ** 32))
  view.setUint32(4, step >>> 0)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const offset = mac[mac.length - 1] & 0x0f
  const code =
    (((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]) % 1_000_000
  return code.toString().padStart(6, '0')
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000)

/**
 * Verifies a code within ±1 step of clock drift. Returns the matched step so the caller can store it and
 * reject replays (any step <= the last accepted step).
 */
export async function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null
  const step = currentStep(now)
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep != null && s <= lastStep) continue
    if ((await totpAt(secretB32, s)) === code) return s
  }
  return null
}

export function otpauthUri(secretB32: string, account: string, issuer = 'Visionary X'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
