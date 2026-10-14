// Password hashing.
//
// Argon2id is the preferred algorithm, but it is not available natively in the Workers runtime and a WASM
// build at OWASP-recommended cost exceeds the free-plan CPU budget (10 ms/request). We therefore use
// PBKDF2-HMAC-SHA256 at the highest iteration count Workers' WebCrypto supports (100,000), with a 16-byte
// random salt. The stored format is versioned (`pbkdf2-sha256$<iter>$<salt>$<hash>`) so hashes can be
// transparently upgraded on next login (see `needsRehash`) if the deployment moves to a paid plan and an
// Argon2id implementation. See docs/SECURITY.md.

import { b64ToBytes, bytesToB64url, randomBytes, safeEqual } from './crypto'

const ITERATIONS = 100_000
const enc = new TextEncoder()

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256)
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2-sha256$${ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so missing accounts are not distinguishable by timing.
    await derive(password, randomBytes(16), ITERATIONS)
    return false
  }
  const [alg, iterS, saltS, hashS] = stored.split('$')
  if (alg !== 'pbkdf2-sha256' || !iterS || !saltS || !hashS) return false
  const iterations = Number(iterS)
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > ITERATIONS) return false
  const candidate = await derive(password, b64ToBytes(saltS), iterations)
  return safeEqual(bytesToB64url(candidate), hashS)
}

export function needsRehash(stored: string): boolean {
  const [alg, iterS] = stored.split('$')
  return alg !== 'pbkdf2-sha256' || Number(iterS) < ITERATIONS
}
