# Security

This describes the controls that are implemented and tested, and the gaps that remain. It is not a certification; an independent review/penetration test is recommended before handling sensitive client material.

## Authentication

- **Passwords**: PBKDF2-HMAC-SHA256, 100,000 iterations (the WebCrypto maximum in Workers), 16-byte random salt, versioned format `pbkdf2-sha256$iter$salt$hash` with `needsRehash()` for transparent upgrades. Argon2id was not used because Workers has no native implementation and a WASM build at OWASP parameters exceeds per-request CPU budgets. Minimum length 12, letters plus digits/symbols. Unknown accounts take the same time to reject.
- **Lockout & rate limits**: 5 consecutive failures lock an account for 15 minutes (user notified, security event logged). Login is limited to 30/15 min per IP and 10/15 min per email; MFA attempts 8/10 min; portal link exchange 20/15 min per IP; reset requests 5/h per IP (D1-backed fixed windows).
- **Sessions**: 256-bit random token in an `HttpOnly; Secure; SameSite=Lax; __Host-` cookie; only its SHA-256 is stored. 12 h idle timeout, 7 day absolute lifetime, sliding renewal. Revoked on logout, password change/reset, role change, deactivation, MFA change, or admin action — and open WebSockets for that session/user are closed immediately.
- **MFA**: RFC 6238 TOTP (±1 step, replay-protected by storing the last accepted step), secrets AES-256-GCM encrypted with `DATA_KEY`, 10 single-use recovery codes (hashed). MFA is **optional by default** (migration 0003); any user can enable it under Account, and roles flagged `requires_mfa` (set in Users & roles) cannot use the API until enrolled. Recommendation: re-enable it for Super Admin, Admin and HR before handling real client data. The session token is rotated after verification.
- **Recovery**: self-service "forgot password" never reveals whether an account exists; it notifies administrators, who verify the person and issue a one-time reset link (24 h, hashed, single use, invalidates earlier links). Lost MFA devices: recovery code, or an admin with `security.manage` resets MFA (audited, sessions revoked).

## Authorisation

- Every API route resolves the session and checks role permissions; record-level rules (`worker/lib/authz.ts`) decide project read/manage/review/contribute rights, member-report visibility and client access. Records you cannot read return **404**, not 403, to avoid revealing existence.
- Privilege escalation is blocked: users can only grant roles strictly below their own rank (except Super Admin); the Super Admin role's permissions are immutable; at least one active Super Admin must remain; users cannot change their own roles or status.
- Separation of duties: reviewers cannot approve their own submissions (unless they manage the project), people cannot decide their own leave or attendance corrections.
- HR has no automatic access to client or project material; colleagues never see private HR fields (DOB, personal contact, address, emergency contact).

## Client portal isolation

- Link secrets (256-bit) are stored only as SHA-256 hashes plus a 4-character hint; they travel in the URL **fragment**, so they never reach server logs, analytics or `Referer` headers, and the page immediately replaces the URL with `/portal/access`.
- The exchange creates a separate portal session (`SameSite=Strict`, HttpOnly, ≤ link expiry, 1 h idle). Every request re-validates the link (revoked/expired/client archived → access ends).
- Portal queries select only: the scoped projects, client-visible milestones, explicitly published updates, deliverables that were shared (and their shared versions), and the client's own feedback. Internal comments, tasks, estimates, staff data, unshared files and other clients are never queried.
- Approving or rejecting a deliverable requires **step-up verification**: the visitor must confirm the email of the contact on file within the configured window; the decision is recorded with that email.
- Portal sessions cannot call staff APIs (separate cookie and middleware).

## Web protections

- CSRF: per-session token in `X-CSRF-Token` on every mutating request plus `Origin` validation; portal uses its own token. SameSite cookies as defence in depth.
- XSS: React escaping, no `dangerouslySetInnerHTML`; strict CSP via `public/_headers` (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`); `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS, restrictive `Permissions-Policy`.
- Injection: every SQL statement is parameterised; dynamic column lists come from fixed allow-maps. JSON bodies are size-capped (256 KB) and validated with Zod; CSV exports neutralise spreadsheet formulas.
- Files: allow-listed types with magic-byte verification, 25 MB cap, random R2 keys, private bucket, downloads only through authorised endpoints with `Content-Disposition: attachment`, `nosniff` and a sandbox CSP. Client-shared files cannot be deleted (record retention). **No antivirus scanning** is performed.
- WebSockets: Origin check against cross-site WebSocket hijacking, session required at upgrade, per-room authorisation on subscribe and again at delivery, 2 KB message cap, 40 messages / 10 s per socket, periodic re-validation, portal sockets restricted to `portal:` rooms and portal event types.

## Audit logging

`activity_logs` records sign-ins, failures, lockouts, MFA events, session revocations, role/permission changes, user lifecycle, exports, settings, holiday verification, attendance edits (with before/after), portal link issue/revoke/use, client downloads and decisions, and all project/task/deliverable changes (with field diffs). Sensitive HR values are not written to the log — only which fields changed. The log is visible to `audit.read` holders.

## Secrets

`SESSION_SECRET` and `DATA_KEY` are Cloudflare secrets (never in the bundle or repo). Seed data uses `.test` emails and a development-only password defined in `scripts/seed.mjs`; never seed production.

## Known gaps / recommendations

1. Argon2id (see above) — revisit if moving to a plan/runtime where it is practical; hashes upgrade on next login.
2. No malware scanning — consider a scanning service before allowing arbitrary client uploads (clients cannot upload today).
3. No email delivery — links are handed over manually by administrators; add a transactional email provider with secrets kept server-side.
4. `DATA_KEY` rotation requires MFA re-enrolment (no re-encryption job).
5. Rate limits are per-IP/per-account in D1; add Cloudflare WAF rate-limiting rules for volumetric protection.
6. Commission an external security review; run `npm test` in CI (the workflow does) and keep dependencies patched.
