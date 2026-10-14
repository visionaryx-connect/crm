const enc = new TextEncoder()
const dec = new TextDecoder()

export function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replaceAll('-', '+').replaceAll('_', '/')
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4))
  const bin = atob(norm + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** URL-safe, high-entropy secret. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return bytesToB64url(randomBytes(bytes))
}

/** Opaque, sortable-ish id with a readable prefix: e.g. tsk_01J…  (time component + 80 random bits). */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0')
  const r = bytesToHex(randomBytes(10))
  return `${prefix}_${t}${r}`
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(input)))
}

export async function sha256Bytes(input: ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', input as BufferSource))
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

async function dataKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64)
  if (raw.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** AES-256-GCM encryption for small secrets stored at rest (e.g. TOTP seeds). Output: v1.<iv>.<ciphertext> */
export async function encryptSecret(keyB64: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await dataKey(keyB64), enc.encode(plaintext))
  return `v1.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`
}

export async function decryptSecret(keyB64: string, payload: string): Promise<string> {
  const [v, ivS, ctS] = payload.split('.')
  if (v !== 'v1' || !ivS || !ctS) throw new Error('Unsupported ciphertext')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivS) as BufferSource }, await dataKey(keyB64), b64ToBytes(ctS) as BufferSource)
  return dec.decode(pt)
}
