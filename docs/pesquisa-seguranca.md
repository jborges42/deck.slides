# Pesquisa de segurança: administrador geral

Referências reunidas em 2026-10-10 para a próxima etapa: ligar o administrador geral, as sessões no servidor e as duas etapas (`server/security/`, `shared/admin.ts`, telas em `src/admin` e `src/account`). Fontes: OWASP ASVS 5.0, OWASP Cheat Sheets, NIST SP 800-63B-4, RFC 6238/4226 e GitHub sudo mode. Cada frente traz o resumo, os requisitos com a fonte e os links.

## Autenticação e armazenamento de senhas

Authentication and password-storage track for deck.slides. Everything was checked on 2026-10-10 against the actual runtime (Node 24.18.0, OpenSSL 3.5.7) and current primary sources: OWASP ASVS 5.0.0 (tag v5.0.0_release, identical to master for V2/V6/V7/V11/V16), the OWASP cheat sheets, NIST SP 800-63B-4 (final, 31 Jul 2025), RFC 9106, the C2SP PHC spec and HIBP.

**Hashing.** Today's hash is not approved. auth.ts calls scrypt with Node's defaults (N=2^14, r=8, p=1). ASVS 5.0 Appendix C, which defines "approved" for requirement 11.4.2, needs N ≥ 2^17 at p=1.
- Replace it with native `crypto.argon2` (Argon2id, added in Node v24.7.0, Stable, no package needed).
- Parameters: m=19456 KiB, t=2, p=1, 16-byte salt, 32-byte tag.
- Store each hash as a standard PHC string in the existing `password` column. Rehash after any successful login whose stored string doesn't start with the current-parameter prefix. Migrate legacy `salt.hash` scrypt values the same way, and close that window within 30 days.
- I checked the implementation:
  - Node reproduces the RFC 9106 Argon2id test vector exactly.
  - Node verifies a hash made by the reference argon2 CLI, and PHP's `password_verify` accepts Node's output.
  - Unknown e-mail, real account and account without a password cost the same time to within about 1 ms.
- Why p=1: Node starts extra OpenSSL threads for every hash when p>1.

**Password policy.**
- Minimum 15 Unicode code points (NIST's rule for single-factor login), no composition rules, NFC normalisation.
- A vendored blocklist: SecLists Pwdb top-1M filtered to 15+ characters, 5,329 entries, 94 KB, MIT licence. Plus context words, compared on the whole password with digits and symbols removed.
- The HIBP range API from the server, with Add-Padding, a 2 s timeout, and acceptance when it can't be reached. Live check: "correct horse battery staple" is 28 characters and has 391 breach hits.
- Skip zxcvbn-ts for v1.

**Online guessing.**
- A per-identifier counter of consecutive failures, persisted in SQLite: 5 free attempts, then a wait from 30 s doubling up to 1 h, and password login disabled at 100 (NIST §3.2.2).
- The per-IP limit stays only as a coarse brake and is never reset on success. Today it is reset on any success (public.ts:80), which would let a moderator keep guessing the super admin's password from one IP indefinitely.
- OWASP device cookies keep a known browser from being locked out by a student on the same venue network.
- A server CLI issues a one-time link to recover a locked-out super admin.

**Resets, re-authentication and other findings.**
- Admins never choose or see passwords. Today they do (Events.tsx:372). Replace with one-time set-password links: 256-bit token, stored only as SHA-256, valid 24 h, single use, token in the URL fragment, no automatic login after use.
- Sensitive super-admin actions require the password again within the last 15 minutes ("sudo mode"), reissuing the session cookie.
- Two other findings break the threat model:
  - The seed creates a known default account with a password published in the repo.
  - When SESSION_SECRET is unset, the cookie-signing key is stored inside deck.db, so a leaked DB backup lets an attacker forge a super-admin session without cracking any hash.

### Requisitos

- ASVS 5.0 V11.4.2 + Appendix C (argon2id t=2: m>=19456, p=1 is 'A'pproved; scrypt p=1 needs N>=2^17): hash staff passwords with Argon2id via node:crypto argon2() (async only; never argon2Sync in a request handler) using m=19456 KiB, t=2, p=1, 16-byte randomBytes salt, 32-byte tag. The current scrypt N=2^14,r=8,p=1 (server/auth.ts:39-49) is NOT approved and must be migrated.
- NIST SP 800-63B-4 §3.1.1.2 ('A reference to the password hashing scheme used, including the cost factor, SHOULD be stored for each password') + C2SP PHC string spec: store '$argon2id$v=19$m=19456,t=2,p=1$<B64 salt>$<B64 hash>' (standard base64, '=' stripped) in the existing moderators.password TEXT column; verify reads m/t/p/salt from the string; needsRehash(stored) = !stored.startsWith(current prefix); after a successful login with needsRehash true, store hashPassword(password).
- OWASP Password Storage CS 'Upgrading legacy hashes': verify legacy 'salt.hash' scrypt values with the old routine on the raw (non-NFC) input and re-hash with Argon2id on that successful login; after <=30 days blank remaining legacy hashes (password='') and issue set-password links (legacy accounts are timing-distinguishable until migrated: 35.0 ms vs 26-27 ms median measured).
- ASVS 11.2.4 / 6.3.8: compare tags with crypto.timingSafeEqual; every login path (unknown e-mail, account with no password yet, malformed hash) must compute exactly one Argon2id hash with the current parameters (dummy hash generated at boot), and return the same 401 body.
- Runtime (Node docs crypto.argon2 'added: v24.7.0'; ncrypto OPENSSL_WITH_ARGON2 requires OpenSSL>=3.2): set engines.node to '>=24.7', deploy official Node binaries/images (bundle OpenSSL 3.5.x), and keep the dummy hash at module load so a build without Argon2 (ERR_CRYPTO_ARGON2_NOT_SUPPORTED) fails at boot.
- NIST SP 800-63B-4 §3.1.1.2: staff passwords used as single-factor SHALL be >=15 characters (8 only if used with MFA), counted as Unicode code points ([...s.normalize('NFC')].length, not zod .min which counts UTF-16 units); SHOULD allow >=64 (keep max 200, ASVS 6.2.9); SHALL NOT impose composition rules (ASVS 6.2.5) or periodic rotation (ASVS 6.2.10); SHOULD NFC-normalise before hashing; verify exactly as received, no trim/truncation/case change (ASVS 6.2.8). Apply on setup, set-password link and password change only, never at login.
- NIST SP 800-63B-4 §3.1.1.2 blocklist + ASVS 6.2.4 (L1, >= top 3000 passwords matching the policy) + 6.1.2/6.2.11: reject new passwords found in a vendored list (SecLists Pwdb_top-1000000 filtered to >=15 code points, lowercased: 5,329 entries / 94 KB) or equal, after stripping digits/symbols/accents, to a documented context word (deck, slides, deckslides, senha, password, admin, administrador, moderador, the user's e-mail local part and name); compare the whole password, never substrings ('The entire password SHALL be subject to comparison'); return the reason for rejection.
- ASVS 6.2.12 (L2) + OWASP Credential Stuffing CS: check new passwords server-side against HIBP Pwned Passwords range API (GET https://api.pwnedpasswords.com/range/<5 hex SHA-1>, headers Add-Padding: true and a User-Agent, AbortSignal.timeout(2000)); reject when count > 0 (padding entries have count 0); on any error/timeout accept (fail open) and log, since the local list still applies offline.
- NIST SP 800-63B-4 §3.1.1.2 'Verifiers SHALL offer guidance': show guidance text on every new-password field (15+ chars, passphrase of ~4 words, password managers welcome), keep type=password + autocomplete current-password/new-password and paste allowed (ASVS 6.2.6/6.2.7), add a 'Mostrar senha' toggle (NIST SHOULD).
- NIST SP 800-63B-4 §3.2.2 + OWASP Authentication CS ('counter of failed logins should be associated with the account itself, rather than the source IP'): persist consecutive failures per typed identifier (normalised e-mail, whether or not an account exists) in a SQLite table; 5 free attempts, then a wait of 30 s doubling to a 1 h cap (NIST's '30 seconds up to an hour'); at 100 consecutive failures disable password login for that identifier until a set-password link is consumed; check before hashing; reset on successful authentication; answer 429 with Retry-After and identical text for existing and non-existing e-mails.
- Fix privilege-escalation path in server/public.ts:74-80: never reset the per-IP login limiter on a successful login (today resetLimit('login:'+ip) lets a moderator interleave own logins with unlimited guesses at the super-admin password); keep per-IP only as coarse anti-automation (ASVS 2.4.1), e.g. 30 per 10 min.
- ASVS 6.1.1 ('prevent malicious account lockout') + OWASP 'Slow Down Online Guessing Attacks with Device Cookies': after a successful login set a signed 'deck_dev' cookie (staffId.nonce, HttpOnly, Secure, SameSite=Strict, Path=/api/auth, 1 year); attempts that present a valid device cookie for the target account skip the per-IP limit and use their own delay counter, while every failure still counts toward the account's NIST 100 cap. This stops a participant on the same venue/classroom NAT from locking staff out.
- ASVS 6.2.3 + OWASP Authentication CS 'Change Password Feature': keep requiring the current password; count wrong current-password attempts in the same persisted per-account counter (replace the in-memory 'pw:'+id limiter at moderator.ts:818); apply the full policy + HIBP to the new password; bump session_epoch and reissue the cookie (already done).
- ASVS 6.4.1 (L1) + 6.4.6 + OWASP Forgot Password CS: admins never choose, see or transmit staff passwords (remove the password field from POST /moderators and the 'Envie o e-mail e a senha' flow, src/moderator/Events.tsx:372); account creation and resets issue a one-time set-password link: token = randomBytes(32).toString('base64url') (ASVS 11.5.1 >=128 bits), stored only as SHA-256 (ASVS 6.5.2 allows a plain hash at >=112 bits; reuse db.ts sha256), expires <=24 h (NIST §4.2 issued recovery code via e-mail: 24 h), single use (DELETE ... changes check inside the same transaction), one live link per account, token in the URL fragment (/definir-senha#token), redemption throttled per IP (NIST §4.2 'SHALL be subject to the throttling requirements'), no automatic login, consumption sets the new hash, bumps session_epoch and clears the failure counter.
- Least privilege for links (ASVS 8.2.1): only super admins may issue set-password links, never for their own account, only after recent re-authentication, each issuance and consumption audited (who, target, when); moderators have no route that can change another account's credentials.
- NIST SP 800-63B-4 §3.2.2/§4.2 (accounts that cannot authenticate SHALL use account recovery): provide a break-glass CLI (node server/admin-cli.ts link <email>) that writes a 24 h one-time link and prints it; shell access to the server is the out-of-band channel for recovering a disabled super admin. Keep at least two super-admin accounts.
- ASVS 7.5.1 / 7.5.3 / 7.2.4 + GitHub 'sudo mode' pattern: sensitive super-admin actions (staff create/delete/disable, role changes, issuing set-password links, terminating others' sessions, system settings) require a password confirmation within the last 15 minutes, checked from the session cookie's issued timestamp; POST /api/auth/reauth verifies the password through the same per-account throttle and reissues the session cookie.
- ASVS 6.3.2 (L1, no default accounts): server/seed.ts must refuse to run with NODE_ENV=production and must not ship a fixed password (today demo@deck.local / 'demo-deck-2026' is in the repo and, once the first account becomes super admin, would be a default super-admin credential).
- Threat-model consistency (cross-track, sessions): SESSION_SECRET must be mandatory in production. Today server/auth.ts:10 falls back to a key stored in deck.db's meta table, so a leaked DB backup lets an attacker forge '<superAdminId>.<now>' cookies without cracking any hash, which defeats the purpose of hardening password storage.
- ASVS 16.3.1 (L2) / NIST §4.2 notification: log every authentication event (login success/failure, throttled, disabled at 100, legacy migration/rehash, password change, link issued/consumed, re-auth) with who/when/IP/user-agent and never the password; the audit trail visible to super admins is the 'designee' notification for recoveries.
- ASVS 6.1.1 / 6.1.2 / 7.1.1 (L1/L2 documentation): document the numbers above (throttle schedule, 100 cap, device-cookie exemption, per-IP limit, link lifetime, sudo window, context-word list) in CLAUDE.md's Segurança section or a SECURITY.md.
- One-time policy upgrade (not periodic rotation, so NIST-compatible): on a successful login whose plaintext fails the new local policy (e.g. the 10-char 'segredo123' style), set must_change_password=1 and gate the console (403 on everything except /auth/password, /auth/me, /auth/logout) until the password is changed.

### Fontes

- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x15-V6-Authentication.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x92-Appendix-C_Cryptography.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x20-V11-Cryptography.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x11-V2-Validation-and-Business-Logic.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md
- https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x17-V8-Authorization.md
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html
- https://community.owasp.org/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- https://doi.org/10.6028/NIST.SP.800-63b-4
- https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback
- https://github.com/nodejs/node/blob/v24.x/doc/api/crypto.md
- https://github.com/nodejs/node/blob/v24.x/deps/ncrypto/ncrypto.cc
- https://github.com/nodejs/node/blob/v24.x/deps/ncrypto/ncrypto.h
- https://github.com/nodejs/node/blob/v24.x/lib/internal/crypto/argon2.js
- https://www.rfc-editor.org/rfc/rfc9106.html
- https://github.com/C2SP/C2SP/blob/main/phc-strings.md
- https://github.com/P-H-C/phc-string-format
- https://haveibeenpwned.com/API/v3#PwnedPasswords
- https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/Pwdb_top-1000000.txt
- https://github.com/danielmiessler/SecLists/blob/master/LICENSE
- https://github.com/zxcvbn-ts/zxcvbn
- https://www.npmjs.com/package/@zxcvbn-ts/core
- https://www.npmjs.com/package/argon2
- https://www.npmjs.com/package/@node-rs/argon2
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode

## Sessões

Recommendation: move staff accounts (moderators and the new super admin) from the HMAC-signed `deck_mod` cookie to server-side sessions in SQLite. Each session gets an opaque 256-bit token that lives only in the cookie. The database stores only its SHA-256. The role is read from the account row on every request (joined in the same query), never stored in the cookie. Staff sessions end after 60 minutes idle or 12 hours absolute. Admin actions also require HTTPS and a password typed in the last 15 minutes from the same IP, and that re-entry swaps the token. Every credential event (login, re-entry, password change, MFA) issues a new token, and every revocation also closes that session's open SSE consoles. Participants keep their signed per-event cookie with the epoch check; only "leave" changes, so it ends the session on the server. Screens keep their hashed device secret, plus self-pairing for the projection opened from the console. On HTTPS all cookies use the `__Host-Http-` prefix: SameSite=Strict for staff, Lax for participants and screens. On plain-HTTP LAN deployments cookies fall back to unprefixed, non-Secure names, and the admin console is refused except from the server machine itself. No new dependencies are needed: node:crypto, node:sqlite and hono/cookie cover everything. Lucia, the reference TypeScript library, was deprecated in March 2025 and its replacement is a copy-paste file that follows this same pattern. I checked the current gaps with proof-of-concept scripts against the real app on a temporary database. A logged-out cookie copy still works. A projection opened with a staff session keeps receiving snapshots, including the event PIN, after that account is deleted. A plain-HTTP client can make `c.req.url` report `https`. The proposed schema and algorithm passed a self-check on node:sqlite 3.53.1 under Node 24.18.

### Requisitos

- ASVS 5.0 V7.2.1/V7.2.3 + OWASP Session Management Cheat Sheet: staff sessions (moderators and super admin) MUST be server-side reference tokens. Generate 32 bytes with crypto.randomBytes (256 bits; ASVS requires at least 128) and send them only in a cookie. Store only the SHA-256 (sessions.id) and validate in a single backend function (validateSession). The cookie carries no id, role or other claims.
- ASVS 5.0 V7.2.4 + OWASP 'renew after any privilege level change' + Copenhagen Book (session fixation): every credential event (login, setup, step-up re-entry, MFA completion, password change) MUST insert a new row and token and delete that browser's previous row. The server MUST never accept a token it did not issue, and MUST never read tokens from the URL or request body.
- ASVS 5.0 V7.4.1 (L1): POST /api/auth/logout MUST delete the session row and close that session's open SSE consoles. Today a copy of deck_mod taken before logout still gets 200 on GET /api/events (verified by script); this is already tracked as a test.todo in server/tests/auth.test.ts.
- ASVS 5.0 V7.3.1/V7.3.2 + NIST SP 800-63B-4 §2.2.3/§2.3.3/§5.2: the server MUST enforce staff timeouts of 60 min idle and 12 h absolute in the SQL WHERE clause. Cookie Max-Age does not count: NIST says cookie expiry 'SHALL NOT be relied upon to enforce session timeouts'. A successful re-authentication resets both timers. The deviation that an open console SSE counts as activity MUST be documented (ASVS V7.1.1).
- ASVS 5.0 V7.5.1/V7.5.3 + NIST AAL3 reauthentication + Copenhagen 'sudo mode': admin-only routes, ending sessions, and changing email, password or MFA MUST require a credential entered in this session at most 15 min ago (sessions.created_at), from the same client IP (sessions.ip). Otherwise respond 403 {reauth:true}. Re-entry MUST check every factor the account has enrolled.
- ASVS 5.0 V7.4.2/V7.4.5 + OWASP privilege-change renewal + Copenhagen 'invalidate all sessions when they gain new permissions': disabling, deleting or changing the role of an account MUST delete all of its sessions and close its streams. Admins MUST be able to end all sessions of one user, or of every user.
- ASVS 5.0 V7.5.2: staff MUST be able to list their active sessions (user agent, last IP, created, last seen, current) and end any or all of them after a recent password entry. The DELETE MUST be scoped by user_id so no one can end another user's session by guessing ids.
- ASVS 5.0 V7.1.2: cap concurrent staff sessions at 5 per account, dropping the least recently used at login. This is one DELETE … NOT IN (… ORDER BY last_seen_at DESC LIMIT 5) inside the login transaction. Document the cap.
- NIST SP 800-63B-4 §5.1 ('SHALL NOT fall back to an insecure transport'; cookies 'SHALL be … accessible only on secure (i.e., HTTPS) sessions'): in production, admin login, re-entry, admin routes and the initial setup MUST require a secure channel. That means HTTPS asserted by the trusted proxy (TRUST_PROXY=1 and X-Forwarded-Proto: https), or a direct loopback connection with no proxy headers. HTTPS MUST NOT be inferred from c.req.url, which the client controls through an absolute-form request target (verified by script), or from X-Forwarded-Proto when TRUST_PROXY is not set.
- ASVS 5.0 V3.3.1/V3.3.3/V3.3.4 + NIST 800-63B-4 browser-cookie list + OWASP: on HTTPS every cookie MUST use the __Host- prefix. Use __Host-Http-: Chrome 140+ and Firefox 143+ enforce it, and Safari applies the __Host- rules. Set Secure, HttpOnly, Path=/ and no Domain. On plain-HTTP LAN deployments fall back to the unprefixed name without Secure, and only read the cookie name that matches the request's scheme.
- ASVS 5.0 V3.3.2 + OWASP ('SameSite=Strict (preferred)'): the staff cookie MUST be SameSite=Strict. It costs nothing in this SPA because index.html needs no auth and every API/SSE call is same-origin after the page loads. Participant and screen cookies stay SameSite=Lax. Keep hono csrf().
- ASVS 5.0 V7.4.1/V7.4.2 for long-lived connections: SSE consoles opened with a staff session MUST re-check the session at each 15 s heartbeat and close when it is revoked or expired. The projection opened from the console (/api/screen/stream?event=) MUST get its own screen credential. Today it survives deletion of the account that opened it and keeps receiving snapshots, including the event PIN (verified by script; kickModerator does not cover it).
- ASVS 5.0 V7.4.1 (participants): keep the HMAC-signed per-event participant cookie with session_epoch, but POST /api/p/:id/leave MUST bump participants.session_epoch so a copied cookie stops working.
- MDN X-Forwarded-For security guidance: with TRUST_PROXY=1, use the rightmost X-Forwarded-For entry (one trusted hop). The Node port MUST be reachable only from the proxy (HOST=127.0.0.1 or a firewall). Otherwise the IP used by the admin check, the session list and the rate limits can be spoofed.
- OWASP Session Management Cheat Sheet: send Cache-Control: no-store on all /api responses (reuse cache('no-store') from app.ts). Do NOT send Clear-Site-Data: "cookies" on logout: per MDN it clears the whole registrable domain, which would unpair screens and drop participant sessions for other events in that browser.

### Fontes

- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x12-V3-Web-Frontend-Security.md
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- https://thecopenhagenbook.com/sessions
- https://thecopenhagenbook.com/server-side-tokens
- https://lucia-auth.com/
- https://github.com/lucia-auth/lucia/blob/main/code/auth_session.ts
- https://pilcrowonpaper.com/blog/18
- https://auth.pilcrowonpaper.com/sessions
- https://auth.pilcrowonpaper.com/auth-sessions
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- https://caniuse.com/mdn-http_headers_set-cookie_http_host-http_prefixes
- https://github.com/httpwg/http-extensions/issues/2605
- https://web.dev/articles/samesite-cookies-explained
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
- https://hono.dev/docs/helpers/cookie
- https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/
- https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html

## Autorização e escalada de privilégio

Today deck.slides authorizes staff with 7 path-prefix `.use()` lines. Any route added under a new prefix is anonymous by default, so the design fails open. Every moderator can read and operate every event (BOLA, broken object-level authorization). Every moderator can also list staff e-mails, create accounts with a password they choose, and hard-delete other accounts (BFLA, broken function-level authorization). An admin role added on top of this would be cosmetic.

I tested the recommended design with a prototype on this exact stack (Node 24.18.0, Hono 4.13.13, zod 4.6.5, node:sqlite with SQLite 3.53.1); 62 of 62 tests pass:
1. **Every route declares a permission.** Each /api route starts with a typed `guard(permission)`, including an explicit `guard('public')`. Each guard is named `authz:<perm>`, and a boot check reads the route list with `inspectRoutes` from `hono/dev`. If a route has no guard, or the guard is not its first handler, the server refuses to start.
2. **Event access comes from membership.** A new `event_members` table holds owner and member rows, with at most one owner per event. Admins are not implicit members: they oversee events through /api/admin, and joining an event themselves is logged and visible to the owner. This follows the GitHub enterprise-owner model and the LGPD necessity principle.
3. **Admin powers need three conditions:** the admin role, an enrolled MFA factor, and a 15-minute re-authentication window ("sudo") tied to the current session, in the style of GitHub sudo mode and GitLab Admin Mode. The sudo cookie must use its own key derived with HKDF. Hono signs only the cookie value, not its name, so I confirmed that a copied session cookie passes as a naive sudo cookie.
4. **Escalation guards:**
   - Strict zod allow-lists on every input.
   - Only admins change roles, and never their own.
   - The role change re-checks the acting admin inside the same database transaction (this blocks the race I reproduced, where two admins demote each other at once).
   - A SQLite trigger keeps at least one active admin.
   - Accounts are disabled, never deleted, and their sessions are invalidated.
   - New staff and password resets use single-use links instead of passwords chosen by the admin (ASVS 6.4.6).
   - Password or MFA resets of another admin happen only through a server CLI.
   - There is no impersonation feature.
5. **Live streams re-check access.** Today, sessions that were revoked keep receiving full moderator snapshots over SSE (server-sent events). The fix re-checks membership and session validity on every push and heartbeat.
6. **Append-only audit log.** Each privileged change writes an `audit_log` row in the same transaction, protected by triggers and copied to stdout, using OWASP Logging Vocabulary names. Notifications appear in-app, plus e-mail when SMTP is configured.
7. **Generated test matrix.** Every route is called by 11 actor types and compared with a hand-written expected table. Denied calls must not write to the database, and a separate test tries child IDs from another event.

No authorization library is worth adding at this size. CASL, Casbin and @hono/casbin would add a second policy language without reducing risk. The one package worth adding for this track is @simplewebauthn/server 14.0.3, for phishing-resistant admin MFA.

### Requisitos

- OWASP Authorization CS (Deny by Default; Validate Permissions on Every Request) + ASVS 5.0 8.2.1 + OWASP API5:2023: every /api route MUST start with guard(<permission>), including an explicit guard('public'). app.ts MUST end with assertGuarded(app), which uses hono/dev inspectRoutes so the server will not start if a route's first handler is not authz:* or if a terminal .all()/.use() responds under /api. Remove the 7 path-prefix requireModerator/requireParticipant .use() lines (server/moderator.ts:28-30, 772-773, 809; public.ts:161), which fail open for any new prefix.
- ASVS 5.0 8.2.2 + OWASP API1:2023 (BOLA): event access MUST be based on membership in event_members(event_id, staff_id, role IN ('owner','member')). GET /api/events MUST join on membership. guard('event') MUST check membership of the canonical ev.id and answer non-members with the same 404 as a nonexistent event. Child queries MUST keep WHERE event_id = ? AND id = ?. Today requireModerator (auth.ts:96-108) and GET /events (moderator.ts:173-192) expose every event to every moderator.
- OWASP API5:2023 (BFLA) + NIST SP 800-53 AC-6(10): staff management MUST move to /api/admin/staff* behind guard('admin'). Today any moderator can list all staff e-mails, create accounts and hard-delete other accounts (moderator.ts:775-805).
- OWASP Mass Assignment CS + OWASP API3:2023 (BOPLA) + ASVS 5.0 8.2.3: self-service and staff endpoints MUST parse input with z.strictObject allow-lists, so an unknown key such as role returns 400. role, disabled and mfa MUST NOT be writable anywhere except PATCH /api/admin/staff/:staffId. Owner membership endpoints always set role 'member'. Responses MUST use explicit column lists or DTOs: never SELECT * on staff, and never return password hashes, session_epoch, MFA secrets or token hashes.
- NIST SP 800-53 AC-5 + Mastodon UserRole own_role rule: an admin MUST NOT change their own role or status (403). A role or status change MUST re-check, inside the same BEGIN IMMEDIATE transaction that writes it, that the actor is still an active admin; this prevents the mutual-demotion race reproduced in the prototype. A SQLite trigger (staff_keep_admin) MUST abort any UPDATE or DELETE that would leave zero active admins.
- ASVS 5.0 8.3.2 + 7.4.2: role, disabled status and membership MUST be read from the database on every request, never stored in a cookie or token. Role changes, disabling, credential/MFA resets and session revocation MUST bump session_epoch. SSE streams MUST be re-checked on every flush and heartbeat (still a member, not disabled, issued >= session_epoch) and closed with 'gone' when the check fails. Today hub.ts keeps pushing full moderator snapshots (invite tokens, e-mails, PIN) to revoked sessions.
- GitHub sudo mode + GitLab Admin Mode + OWASP MFA CS + ASVS 5.0 7.5.1/7.5.3: guard('admin') MUST require role=admin AND an enrolled MFA factor AND a fresh sudo window. Sudo means re-authenticating with password + second factor or a passkey with user verification; it lasts 15 minutes, is tied to the current session's issuedAt, and allows 5 attempts per 15 minutes per account. guard('staff.sudo') protects a user's own MFA, e-mail and session changes. The SPA reacts to authz='sudo_required' by asking the user to re-authenticate.
- Cookie domain separation (verified: Hono signs only the cookie value, not its name): each signed cookie type MUST use its own key, derived with crypto.hkdfSync('sha256', SESSION_SECRET, '', 'deck:<purpose>', 32). A sudo cookie signed with the session key in id.timestamp format accepts a copied deck_mod value (reproduced). That would let anyone holding a stolen session less than 15 minutes old skip sudo.
- OWASP MFA CS (Require MFA for administrative users) + ASVS 5.0 6.3.3 + NIST SP 800-63B-4 AAL2: admin capabilities MUST stay disabled until MFA is enrolled (403 mfa_required). Offer passkeys (@simplewebauthn/server) as the phishing-resistant option, with TOTP as fallback and never SMS. Admin base sessions SHOULD be capped at 24 h.
- ASVS 5.0 6.4.6 + 6.4.1 + 6.4.3: admins MUST NOT choose or learn another user's password. Replace the admin-set password in POST /moderators with single-use, hashed (sha256), expiring links that the user completes: invites (<=72 h) and resets (<=24 h). Resets revoke sessions and do not bypass MFA. Password or MFA resets of another admin MUST be possible only through the operator CLI, to block one admin taking over another.
- NIST SP 800-53 AC-2(3)/AC-2(4) + ASVS 5.0 7.4.2: staff accounts MUST be disabled (disabled_at), never hard-deleted through the API. Disabling ends sessions and streams immediately and keeps audit references valid. LGPD erasure requests are handled by anonymizing the account through the CLI.
- GitHub enterprise-owner model + LGPD art. 6 III (necessidade): admins MUST NOT be implicit event members. Oversight goes through /api/admin/* with sudo: listing all events, deleting, transferring ownership, and adding or removing members, including themselves. An admin adding themselves to an event MUST be audited (authz_admin) and visible in the event's member list.
- GitHub Enterprise Server impersonation model: there MUST be no impersonation endpoint. If one is ever added, it must require a reason, last at most 1 h, notify the user by e-mail, record both identities in the audit log, be read-only, and never allow one admin to impersonate another.
- ASVS 5.0 16.3.1-16.3.3 + NIST AC-6(9)/AC-2(4) + OWASP Logging CS/Logging Vocabulary: every privileged action MUST insert an audit_log row in the SAME transaction as the change. This covers role changes, staff invite/disable/enable, credential or MFA resets, session revocation, membership or ownership changes, event deletion, settings changes, sudo success or failure, and CLI commands. Rows use vocabulary names (authz_change, authz_admin, authz_fail, user_created, user_updated, sys_*) and record actor, target, event, IP, UTC time and reason. Passwords, tokens, PIN and cookies are never logged.
- ASVS 5.0 16.4.2/16.4.3 + OWASP Logging CS (tamper detection): audit_log MUST be append-only, enforced by BEFORE UPDATE/DELETE triggers that RAISE(ABORT). Each row MUST also be printed as one JSON line on stdout so a copy is kept outside the database. No API may edit or delete audit rows; retention purges run only through the operator CLI and are themselves logged.
- ASVS 5.0 16.3.2 + OWASP Top 10:2025 A01 (log access-control failures): every guard denial MUST be logged as authz_fail (JSON on stdout). Attempts by a logged-in staff member to use a higher privilege (denied for role or owner) MUST also be written to audit_log so admins can see probing.
- NIST SP 800-63B-4 sec. 4.6 + ASVS 5.0 6.3.7 + OWASP MFA CS: security-relevant changes MUST notify the affected user and all admins. In-app notices built from audit_log are required. E-mail when SMTP is configured is recommended; NIST requires a separate channel for adding an authenticator and for account recovery.
- ASVS 5.0 6.3.2 (no default accounts): /api/auth/setup MUST create the first account as admin and ALWAYS require a setup token. When SETUP_TOKEN is unset and no staff exists, generate a one-time token at boot and print it; today dev mode needs no token even though vite --host exposes it on the LAN. seed.ts MUST refuse to run with NODE_ENV=production.
- OWASP Authorization CS (unit/integration tests) + OWASP API1:2023 (do not deploy changes that make the tests fail) + WSTG-ATHZ-02: server/tests/authz.test.ts MUST call every route returned by assertGuarded(app) as each of 11 actors and compare against a hand-written EXPECT map. A route without an EXPECT row, or a row without a route, fails the test. Denied calls MUST return 401/403/404 with the authz marker and write nothing to the database except audit rows. CI blocks deploy on failure.
- OWASP API1:2023: a generated cross-event test MUST call every route that takes a child id as a member of event A, using child ids from event B, and assert that B's rows are unchanged. A final check MUST assert that no route outside /api/admin changed any staff role.
- ASVS 5.0 7.4.1: logout MUST invalidate the session on the server (bump session_epoch, or move staff sessions to a server-side table) and clear the sudo cookie. Today the signed cookie stays valid for 30 days after logout (public.ts:85-88).
- ASVS 5.0 8.3.1 + OWASP Authorization CS (checks in the right location): the SPA may hide admin UI based on /api/auth/me, but enforcement MUST live only in guard(). /api/screen/stream?event= MUST become /api/events/:id/screen/stream with guard('event'); today any staff session can stream any event's screen (public.ts:269-275).
- NIST AC-5 (separation of duties): security invariants (admin MFA requirement, sudo window, audit logging, session limits, CSRF/CSP) MUST live in code or environment variables controlled by the server operator, never in admin-editable settings. The system-settings schema MUST be a strictObject with no secrets, and changes MUST be audited with before and after values.
- Admin-on-admin actions: promoting, demoting or disabling another admin MUST require sudo, a reason stored in the audit row, and an immediate notice to every admin. Emergency recovery (promote, demote, disable, reset-mfa) MUST exist only as an operator CLI (Mastodon tootctl model).

### Fontes

- https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- https://top10.owasp.org/2025/A01_2025-Broken_Access_Control
- https://top10.owasp.org/2025/
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
- https://github.com/OWASP/ASVS/blob/master/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md
- https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization
- https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization
- https://api-security.owasp.org/editions/2023/en/0xa5-broken-function-level-authorization
- https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html
- https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode
- https://docs.github.com/en/enterprise-cloud@latest/admin/managing-accounts-and-repositories/managing-roles-in-your-enterprise/abilities-of-roles
- https://docs.github.com/en/enterprise-server@3.21/admin/managing-accounts-and-repositories/managing-users-in-your-enterprise/impersonating-a-user
- https://docs.gitlab.com/administration/settings/sign_in_restrictions/
- https://github.com/mastodon/mastodon/blob/main/app/models/user_role.rb
- https://github.com/mastodon/mastodon/blob/main/app/policies/user_policy.rb
- https://docs.joinmastodon.org/admin/tootctl/
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-6/
- https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-5/
- https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-2/
- https://zod.dev/api?id=objects
- https://hono.dev/docs/helpers/dev
- https://github.com/MasterKale/SimpleWebAuthn
- https://www.npmjs.com/package/@simplewebauthn/server
- https://github.com/stalniy/casl
- https://www.npmjs.com/package/@hono/casbin
- https://www.npmjs.com/package/accesscontrol
- https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- https://modeloinicial.com.br/lei/LGPD/lei-geral-protecao-dados-pessoais/art-6

## Verificação em duas etapas (TOTP)

Recommendation for v1: TOTP built only on node:crypto (about 70 lines, no new dependency) plus 10 single-use recovery codes. MFA is mandatory for the super admin and optional for moderators. I checked the TOTP code against all 10 vectors in RFC 4226 Appendix D and all 18 in RFC 6238 Appendix B. Parameters: a 160-bit seed generated on the server, HMAC-SHA-1, 6 digits, 30 s steps, and a ±1 step window based on the server clock only.

Security depends on application logic that no library provides:
1. **Replay protection.** Store the last accepted time step per user and update it with a SQL compare-and-set (this is the CVE-2015-7225 lesson).
2. **Rate limiting per account, not per session or IP.** Allow 5 attempts per 15 minutes, and disable the TOTP factor after 100 consecutive failures (NIST SP 800-63B-4 §3.2.2; the AuthQuake bypass worked because limits were per session).
3. **A pending-MFA cookie that grants nothing.** It must be signed with its own key derived via HKDF. I reproduced the risk against the project's Hono 4.13.13: Hono signs only the cookie value, not its name, so a naive pending cookie in the format "id.ms" is accepted as `deck_mod`. That is a full MFA bypass.
4. **Secrets kept out of SQLite.** Encrypt TOTP seeds with AES-256-GCM under an `MFA_KEY` taken from the environment. In production, require `SESSION_SECRET` from the environment too. Today it falls back to a value stored in the same SQLite file, so anyone with a database backup could mint an MFA-verified admin cookie.

Make "an admin without MFA" impossible with a SQLite CHECK constraint (I verified it works on SQLite 3.53.1). Admin routes should require all of:
- the admin role, read from the database on every request;
- a session marked as MFA-verified (aal2);
- a session no older than 12 h;
- for dangerous operations, a full re-authentication within the last 10 minutes.

Do not add `otpauth` or `otplib`. In Node they call `createHmac` and `timingSafeEqual` from node:crypto anyway, and they leave replay protection and rate limiting to the application.

Passkeys via SimpleWebAuthn 14 are the phishing-resistant upgrade. NIST 800-63B-4 says AAL2 verifiers SHALL offer a phishing-resistant option, so this is planned, not skipped. It belongs in v1.1, once there is a stable HTTPS domain: a passkey's RP ID cannot be an IP address, the app is used on LAN IPs at events, and the server package pulls in 25 packages and had 3 security advisories in 2026.

### Requisitos

- RFC 4226 R6 + NIST SP 800-63B-4 §3.1.5.1 + ASVS 5.0 6.5.3: the TOTP seed MUST be 20 bytes (160 bits) from crypto.randomBytes, generated on the server; the client never supplies a seed.
- RFC 6238 §4 + Google Key-Uri-Format: MUST use HMAC-SHA-1, 6 digits, 30 s period (Google Authenticator ignores algorithm and period, and digits on Android); HMAC-SHA-1 is unaffected by SHA-1 collision attacks (RFC 4226 App. B.2).
- RFC 6238 §4.2: the time-step counter MUST be encoded as an 8-byte big-endian integer (writeBigUInt64BE) so it keeps working after 2038 (verified with the T=20000000000 vector).
- RFC 6238 §5.2/§6 + SP 800-63B-4 §3.1.5.2 + ASVS 5.0 6.5.8: accept only time-steps t-1..t+1 computed from the server clock (NTP-synced); never accept a client-supplied time.
- RFC 6238 §5.2 (verifier MUST NOT accept the second attempt) + SP 800-63B-4 §3.1.5.2 + ASVS 5.0 6.5.1 + CVE-2015-7225: persist the last accepted time-step per user (totp_step), accept only steps greater than it, record the HIGHEST matching step, and commit with compare-and-set UPDATE ... WHERE id = ? AND totp_step < ? requiring changes = 1.
- Constant-time check (codebase convention safeEqual / Node crypto.timingSafeEqual): validate the code is exactly 6 ASCII digits first, then compare with timingSafeEqual on equal-length buffers.
- SP 800-63B-4 §3.2.2 + RFC 4226 §7.3 + AuthQuake (Oasis 2024): throttle second-factor attempts per ACCOUNT, not per pending cookie or IP: overLimit('mfa:'+id, 5, 15 min) on every endpoint that checks a code, plus a persistent consecutive-failure counter (totp_failures) that disables the TOTP authenticator at 100 failures while recovery codes keep working.
- OWASP MFA Cheat Sheet + ASVS 5.0 6.3.4: after a correct password on an MFA account the server MUST issue only a pending cookie (deck_mfa: HttpOnly, SameSite=Strict, Path=/api/auth, Max-Age 300, bound to session_epoch) that no authorization middleware accepts; it grants nothing except POST /api/auth/mfa.
- Codebase-specific (reproduced against node_modules/hono 4.13.13): Hono signs only the cookie value and readSession ignores extra dot-parts, so deck_mod and deck_mfa MUST be signed with different HKDF-derived keys (hkdfSync sha256, info 'deck.slides cookie <purpose>'); otherwise a pending cookie is a valid moderator session (full MFA bypass).
- ASVS 5.0 7.2.4 + OWASP Session Management Cheat Sheet (renew after privilege change): completing the second factor, re-authenticating (sudo) and any factor change MUST issue a new session cookie and delete the pending cookie.
- SP 800-63B-4 §5.1 (a session SHALL NOT be considered at a higher AAL than its authentication event): the session MUST carry aal 1|2 and the time of the last full authentication; every endpoint that re-issues the cookie, including the existing POST /api/auth/password, MUST verify the second factor of MFA accounts before issuing aal2.
- ASVS 5.0 8.2.1 + 8.3.2: role MUST be read from the database on every request (never from the cookie); requireAdmin = role 'admin' in DB AND aal 2 AND last full authentication at most 12 h ago (SP 800-63B-4: AAL2 overall reauthentication SHOULD be at most 24 h).
- OWASP MFA Cheat Sheet (require MFA for administrative users) + ASVS 5.0 6.3.3: make admin-without-MFA unrepresentable with a SQLite CHECK (role = 'moderator' OR totp_secret IS NOT NULL); promotion requires an enrolled factor and the initial SETUP_TOKEN account is created already enrolled.
- ASVS 5.0 7.5.3 + OWASP MFA Cheat Sheet (sensitive actions): role changes, staff deletion, MFA resets, system settings and recovery-code regeneration MUST require a full authentication within the last 10 minutes (sudo), obtained via POST /api/auth/reauth with password + code.
- OWASP MFA Cheat Sheet + ASVS 5.0 6.5.3 + Key-Uri-Format: enrollment MUST generate the seed server-side, keep it only as totp_pending (encrypted), return the otpauth:// URI and grouped base32 key once with Cache-Control: no-store, render the QR locally with uqr (already a dependency; never a third-party QR service), and activate only after a valid code, storing the confirming step as totp_step.
- ASVS 5.0 7.5.1 + OWASP MFA Cheat Sheet (reauthenticate with an existing factor before changes): replacing the authenticator MUST require sudo and keep the old seed active until the new one is confirmed; disabling MFA MUST require password + current code (or recovery code) and is impossible for admins.
- ASVS 5.0 7.4.3: enabling, disabling, resetting or replacing a factor MUST bump session_epoch (ends all other sessions and pending cookies) and re-issue the caller's cookie.
- SP 800-63B-4 §3.1.2.2 and §4.2.1 + ASVS 5.0 6.5.1/6.5.2: 10 recovery codes of 24 Crockford characters from the existing newCode(24) (120 bits, CSPRNG), shown once, stored as sha256 of the normalized code in recovery_codes, consumed with DELETE ... WHERE user_id = ? AND hash = ? (changes = 1 means valid, single use), regenerated only under sudo and replaced atomically.
- RFC 4226 §7.5 + RFC 6238 §5.1 + SP 800-63B-4 §3.1.5.2 + ASVS 5.0 13.3.1: TOTP seeds MUST be encrypted at rest with AES-256-GCM using MFA_KEY (32 random bytes) from the environment, random 96-bit IV, AAD 'totp:<userId>' and explicit authTagLength 16 (Node DEP0182); in production the key never lives in SQLite.
- Codebase-specific (auth.ts line 10): in production the server MUST refuse to start without SESSION_SECRET and MFA_KEY from the environment; the current meta-table fallback stores the cookie key in the same SQLite file, so a leaked backup would allow minting aal2 admin cookies.
- ASVS 5.0 6.4.3/6.4.4 + GitLab practice (admin 2FA cannot be disabled through the API, only from the server console): no recovery path may bypass MFA; a lost admin factor is handled by demotion plus reset by another admin (sudo, audited, never on self) or, for the sole admin, by a server-side CLI break-glass where shell access is the identity proof.
- ASVS 5.0 6.3.5/6.3.7 + SP 800-63B-4 §4.1.2.1/§4.2.1 + OWASP MFA Cheat Sheet: audit every MFA event (enabled, replaced, disabled, reset, recovery code used, failure, authenticator disabled) without codes or secrets, and show failed second-factor attempts since the last login plus remaining recovery codes after each login; out-of-band (email) notification is a known gap until the app sends mail.
- OWASP MFA Cheat Sheet + ASVS 5.0 6.3.4: no remember-this-device, API token or alternate login path that skips the second factor for admin accounts.
- Dependency decision: implement TOTP with node:crypto (verified against all RFC 4226 App. D and RFC 6238 App. B vectors); do not add otpauth or otplib, which in Node delegate to createHmac/timingSafeEqual and leave replay protection and throttling to the application.
- SP 800-63B-4 §3.2.5 (manual-entry OTP SHALL NOT be considered phishing-resistant) + AAL2 (verifiers SHALL offer a phishing-resistant option): plan passkeys for admins in v1.1 with @simplewebauthn/server 14.0.2 or newer (14.0.3 current), attestationType none, userVerification required, registration only from an aal2 admin session, once the deployment has a stable HTTPS domain (an RP ID cannot be an IP address).

### Fontes

- https://www.rfc-editor.org/rfc/rfc6238
- https://www.rfc-editor.org/rfc/rfc4226
- https://www.rfc-editor.org/rfc/rfc4648
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md
- https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md
- https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md
- https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x22-V13-Configuration.md
- https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://github.com/google/google-authenticator/wiki/Key-Uri-Format
- https://datatracker.ietf.org/doc/draft-andesco-otpauth-uri/
- https://www.potaroo.net/ietf/idref/draft-linuxgemini-otpauth-uri
- https://www.oasis.security/blog/oasis-security-research-team-discovers-microsoft-azure-mfa-bypass
- https://cveawg.mitre.org/api/cve/CVE-2015-7225
- https://www.openwall.com/lists/oss-security/2015/09/17/2
- https://github.com/mdp/rotp/issues/44
- https://github.com/devise-two-factor/devise-two-factor
- https://docs.gitlab.com/security/two_factor_authentication/
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode
- https://github.com/hectorm/otpauth
- https://registry.npmjs.org/otpauth
- https://github.com/advisories/GHSA-rmmc-8cqj-hfp3
- https://github.com/yeojz/otplib
- https://www.npmjs.com/package/@oslojs/otp
- https://github.com/MasterKale/SimpleWebAuthn/releases
- https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-6hxq-p678-4hr2
- https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-2g3p-m8c9-hhwh
- https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-j3h4-m3m2-7p7j
- https://www.w3.org/TR/webauthn-3/
- https://web.dev/articles/webauthn-rp-id
- https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf
- https://nodejs.org/docs/latest-v24.x/api/deprecations.html#DEP0182
- https://nodejs.org/docs/latest-v24.x/api/crypto.html
- https://www.nist.gov/news-events/news/2022/12/nist-retires-sha-1-cryptographic-algorithm
- https://thecopenhagenbook.com/mfa
- https://github.com/unjs/uqr

## Endurecimento da aplicação web

deck.slides already has a solid web baseline: a JSON-only API with no CORS, hono/csrf, a production CSP with object-src 'none' and frame-ancestors 'none', nosniff, COOP/CORP same-origin, a same-origin Referrer-Policy, zod on every input, parameterized node:sqlite, React escaping, a sandboxed embed iframe, random upload filenames and generic 500s. I ran the real code with a scratch DATA_DIR and found these gaps that matter before adding a super administrator:

1. **Rate limits can be bypassed.** clientIp() takes the leftmost X-Forwarded-For entry, so rotating that header bypasses the login, PIN and setup limits. With TRUST_PROXY=1 and nginx-style appending, 30 failed logins from one real IP produced zero 429s.
2. **Node 24.18.0 is behind a security release.** The 2026-07-28 release (24.18.1) fixes 11 CVEs, including request smuggling (CVE-2026-58044) and node:sqlite (CVE-2026-58041). Upgrade to 24.21.0.
3. **Cookie Secure comes from the client.** It is derived from the X-Forwarded-Proto header, and no __Host- prefix is used.
4. **API responses have no Cache-Control: no-store.**
5. **There is no security or audit logging.** The only error log interpolates the decoded URL path, so a crafted URL can inject fake log lines.
6. **Upload contents are not checked.** There is no magic-byte check, SVGs are stored as uploaded, every kind defaults to a 1 GB limit, and there is no quota.
7. **Logout does not revoke the session server-side.** The seed script can create a known-password account in production, bypassing SETUP_TOKEN.
8. **Anonymous clients can grow server memory.** The rate-limit map and the screen-pairing map have no size cap.

**Fixed during the review.** Another agent changed the code while I worked. One production-only bug was fixed at 02:12: the /media sandbox CSP had been overwritten by the global CSP. It needs a test that runs with NODE_ENV=production so it cannot come back.

**Recommendation:**
- **Packages:** stay on the platform and Hono built-ins. Do not add helmet, hono-rate-limiter (0.x, and its README example keys on the raw X-Forwarded-For header), file-type, DOMPurify with jsdom, or pino.
- **Code changes:** add about six small pieces:
  - a Fetch Metadata + Origin CSRF middleware, strict on /api/admin, plus JSON-only bodies;
  - __Host- and SameSite=Strict cookies driven by configuration;
  - no-store on /api;
  - a trusted client IP with /56 IPv6 keys and capped maps;
  - upload signature, SVG and quota checks;
  - an append-only audit_log table plus JSON log lines.
- **pnpm 11:** set an explicit 7-day minimumReleaseAge, trustPolicy no-downgrade, audit in CI and an SBOM.
- **Deployment:** run behind a TLS reverse proxy as an unprivileged, sandboxed systemd or Docker service.

The details include a prioritized ASVS 5.0 checklist (DONE / PARTIAL / MISSING) mapped to this code.

### Requisitos

- nodejs.org July 2026 security releases + ASVS 5.0 V15.2.1/V4.2.1 [P0, MISSING]: run Node >= 24.21.0 (never below 24.18.1) in every environment. The installed 24.18.0 is affected by 11 CVEs, including CVE-2026-58044 (HTTP parser header truncation, request smuggling), CVE-2026-58041 (node:sqlite) and CVE-2026-56848 (HTTP/2 use-after-free). Pin with package.json engines.node '>=24.21.0' plus pnpm engineStrict: true.
- ASVS 5.0 V4.1.3 + V15.3.4 + V6.3.1 (MDN X-Forwarded-For) [P0, MISSING]: with TRUST_PROXY=1, use the RIGHTMOST X-Forwarded-For entry (the one the trusted proxy appended), validate it with net.isIP, and listen only on 127.0.0.1 or a private network so nobody can inject the header by bypassing the proxy. Reproduced: leftmost parsing plus nginx $proxy_add_x_forwarded_for gave 30 failed logins from one real IP and zero 429s.
- ASVS 5.0 V3.3.1 + V3.3.3 + V4.1.3 (NIST SP 800-63B-4 sec. 5.1) [P0, MISSING]: decide the cookie Secure attribute from configuration (PUBLIC_URL is https), never from the client-supplied X-Forwarded-Proto header. Use the __Host- prefix (Hono prefix 'host' on setSignedCookie/getSignedCookie/deleteCookie) for deck_mod, deck_p_<event> and deck_screen in HTTPS deployments.
- ASVS 5.0 V3.3.2 [P1, PARTIAL]: use SameSite=Strict for staff (moderator and super-admin) cookies. It costs nothing in this SPA because the HTML shell is public and every authenticated call is a same-site fetch. Keep HttpOnly (V3.3.4, done).
- ASVS 5.0 V14.3.2 + V14.2.2 (OWASP HTTP Headers CS) [P0, MISSING]: send Cache-Control: no-store on every /api/* response (PIN, invite tokens, e-mails, staff data). SSE responses may keep no-cache.
- ASVS 5.0 V16.2.1/V16.2.2/V16.3.1/V16.3.2/V16.3.3 (OWASP Logging CS + Logging Vocabulary CS) [P0, MISSING]: log authentication success and failure (including 429 lockouts), logout, password/MFA/step-up events, initial setup, staff create/update/delete, role/permission/event-assignment changes, every super-admin action (authz_admin), every 403 (authz_fail, CRITICAL), CSRF rejects (malicious_csrf), upload stored/rejected/deleted and event deletion. Each entry records UTC ISO-8601 time, actor id and role, trusted client IP, truncated user agent, route pattern, target and outcome.
- ASVS 5.0 V16.2.5 + V14.2.1 (OWASP Logging CS, data to exclude) [P0]: never log passwords, PINs, invite tokens, screen secrets, cookies, SESSION_SECRET/SETUP_TOKEN, MFA codes or request bodies. Log the route pattern (/api/invite/:token), not the raw path. For a failed login, record the account id (or nothing), never the typed string. Redact /convite/<token> and /api/invite/<token> in reverse-proxy access logs.
- ASVS 5.0 V16.4.1 + V16.2.4 [P1, MISSING]: write every log record as one JSON object per line (JSON.stringify). The current onError puts the decodeURI-decoded path into a template string, so a %0A in a URL creates fake log lines.
- ASVS 5.0 V16.4.2 + V16.4.3 [P1, MISSING]: keep the admin audit trail in an append-only SQLite table. A BEFORE UPDATE trigger always raises ABORT, and a BEFORE DELETE trigger allows deleting only rows past retention. Only the super admin can read it, and no API edits or deletes it. Also forward the stdout JSON lines to a log store outside the host.
- ASVS 5.0 V13.4.2 + V16.5.3 [P0, PARTIAL]: fail secure on configuration. Treat every NODE_ENV except an explicit 'development' or 'test' as production (this controls SETUP_TOKEN and the CSP), require PUBLIC_URL in production, and reject at boot a SETUP_TOKEN shorter than 32 random characters while no account exists. Keep the new SESSION_SECRET >= 32 check in index.ts.
- ASVS 5.0 V15.2.3 + V13.2.3 + V6.4.1 [P0, MISSING]: server/seed.ts must refuse to run in production (and against a DATA_DIR that already has real accounts) and must never create a privileged account. Its demo-deck-2026 password is public in the repo and the script bypasses SETUP_TOKEN.
- ASVS 5.0 V7.4.1 + V7.3.1/V7.3.2 (NIST SP 800-63B-4 AAL2/AAL3) [P0, MISSING, auth track]: logout must invalidate the session on the server. Today it only deletes the cookie, so a copied deck_mod cookie stays valid for 30 days. Super-admin sessions need server-enforced idle (15-60 min) and absolute (12 h) limits.
- ASVS 5.0 V8.2.1 + V8.3.1 + V16.5.3 [P0, MISSING, RBAC track]: deny by default at the router. Use moderator.use('*', requireModerator) plus a dedicated /api/admin router whose first middlewares are sameOrigin(strict) and requireRole('superadmin'). Today each protected prefix needs its own use() line, so any new route added without one is public.
- ASVS 5.0 V3.5.1/V3.5.2/V3.5.3/V3.5.8 (OWASP CSRF CS Fetch Metadata section; web.dev Fetch Metadata) [P1, PARTIAL]: replace hono/csrf, which inspects only form and text/plain bodies, with one Fetch Metadata middleware on /api/*. Allow Sec-Fetch-Site same-origin (plus 'none' for GET/HEAD); otherwise require Origin to equal the PUBLIC_URL origin (the mandatory fallback). On /api/admin/*, refuse writes when both headers are missing. Log every reject.
- OWASP CSRF CS (Disallowing simple content types) + ASVS 5.0 V3.5.2 [P1, MISSING]: make the shared body() helper reject any Content-Type other than application/json. Then no form or text/plain request, cross-site or injected same-origin, can drive a JSON endpoint.
- ASVS 5.0 V3.2.1 + V3.4.6 + V5.4.1 [P1, PARTIAL]: keep serving /media with the sandbox CSP. In production it was overwritten by the global CSP until the 02:12 fix; pin it with a test that runs under NODE_ENV=production. Add frame-ancestors 'none' to the media CSP and Content-Disposition: attachment for .svg files.
- ASVS 5.0 V5.2.2 + V1.3.4 (OWASP File Upload CS) [P1, MISSING]: check the file signature (magic bytes) for every accepted extension (PNG, JPEG, GIF, WebP, AVIF, MP4, MOV, WebM, Ogg, WOFF, WOFF2, TTF, OTF) and reject mismatches. Reject, rather than sanitize, SVGs that contain script, foreignObject, iframe, embed or object elements, on* event handlers, javascript: URLs or ENTITY declarations.
- ASVS 5.0 V5.2.1 + V5.2.4 + V15.2.2 [P1, PARTIAL]: set per-kind size limits (image about 25 MB, font about 10 MB, video = MAX_UPLOAD_MB with a default below 1 GB), a per-event storage quota, and a minimum free-disk threshold (fs.statfs). Check them both before and during streaming.
- ASVS 5.0 V3.4.1 + V3.4.3 + V3.4.6 (OWASP HTTP Headers CS) [P1, PARTIAL]: set HSTS to max-age=63072000; includeSubDomains (Hono's default of 15552000 s, 180 days, fails the 1-year minimum), CSP base-uri 'none' and X-Frame-Options DENY. Keep object-src 'none', script-src 'self', frame-ancestors 'none', COOP/CORP same-origin, Referrer-Policy same-origin and nosniff.
- ASVS 5.0 V2.4.1 + V15.2.2 (Node.js security best practices, CWE-400) [P1, MISSING]: cap everything an anonymous client can grow:
- a global cap on the rate-limit Map (refuse new keys when full, and log);
- a cap on pending screen pairings and on streams per pairing secret;
- check the per-IP lookup limit and that the invite token exists before creating per-token PIN keys;
- set server.maxConnections.
Per-IP limits must allow for venue NAT (hundreds of legitimate users behind one IP), so put the security-relevant limits on per-account, per-token and per-event keys.
- ASVS 5.0 V6.3.1 (express-rate-limit ipv6Subnet) [P1, MISSING]: group IPv6 rate-limit keys by /56. Add a per-invite-token PIN failure cap that does not depend on IP: a leaked invite link with a 4-digit PIN can otherwise be brute-forced from many IPs.
- ASVS 5.0 V16.5.4 + V16.3.4 [P1, MISSING]: add process.on('uncaughtException') that logs sys_crash as JSON and calls exit(1), so systemd or Docker restarts a clean process.
- pnpm 11 docs + Node.js security best practices + ASVS 5.0 V15.2.1/V15.2.4 [P1, PARTIAL]:
- set minimumReleaseAge explicitly to 10080 minutes (an explicit value also turns minimumReleaseAgeStrict on);
- set trustPolicy: no-downgrade with trustPolicyIgnoreAfter: 43200;
- keep blockExoticSubdeps and strictDepBuilds true and allowBuilds empty;
- remove the @base-ui exclusions once those versions age past the window (published 2026-10-09);
- put the project under git and run pnpm install --frozen-lockfile plus pnpm audit --audit-level moderate in CI.
- ASVS 5.0 V15.1.1/V15.1.2 [P1/P2, MISSING]: document deadlines for fixing vulnerable components (e.g., critical/high within 72 h, moderate within 30 days), and publish a CycloneDX SBOM per release with pnpm sbom --sbom-format cyclonedx --prod.
- ASVS 5.0 V12.1.1/V12.2.1/V12.2.2 [P0 for production, deployment]: terminate TLS 1.2/1.3 with publicly trusted certificates at the reverse proxy (Caddy or nginx). The proxy must overwrite X-Forwarded-For, and only the proxy may reach Node.
- ASVS 5.0 V13.2.2 + V13.3.1/V13.3.2 (OWASP NodeJS Docker CS) [P1, MISSING]: run Node as an unprivileged user with OS sandboxing: either systemd (NoNewPrivileges, ProtectSystem=strict, ReadWritePaths=DATA_DIR, an empty CapabilityBoundingSet) or Docker (USER node, read_only, cap_drop ALL). Set DATA_DIR to mode 0700, load secrets from a 0600 EnvironmentFile, systemd credentials or Docker secrets, and encrypt DB backups.
- ASVS 5.0 V15.2.3 [P1, MISSING]: ship only dist, server, shared and runtime dependencies to production. Move frontend-only packages to devDependencies and install with pnpm install --prod --frozen-lockfile. No Vite, seed script or tests on the server.
- ASVS 5.0 V15.2.3 + V13.4.2 [P2, PARTIAL]: keep the dev server off the LAN by default (vite without --host, with an opt-in script), and require a setup token in development too (generate and print one at boot). Otherwise a fresh dev instance on event Wi-Fi can be claimed by the first visitor, who becomes the super admin.
- ASVS 5.0 V3.4.7 + V3.4.3 (Base UI CSPProvider docs) [P3, MISSING]: add a CSP violation-report endpoint (rate-limited, small body limit, exempt from the Fetch Metadata check). Drop style-src 'unsafe-inline' by wrapping the app in CSPProvider with disableStyleElements and moving its two scrollbar rules into styles.css. Roll out with Content-Security-Policy-Report-Only first.
- ASVS 5.0 V3.2.2 [P3, PARTIAL]: render the join QR code as an img element with a data:image/svg+xml URL instead of dangerouslySetInnerHTML. The uqr.renderSVG output is safe today (numeric path data and constant colors only), but this removes the only HTML sink. Add a test that fails when new innerHTML, dangerouslySetInnerHTML or eval sinks appear.
- ASVS 5.0 V3.6.1 + V14.2.3 + V13.1.1 [P3, PARTIAL]: Google Fonts CSS is generated dynamically, so it cannot carry SRI, and loading it exposes participants' IPs to Google. The https images and iframes moderators choose do the same with other sites. Document both as accepted third-party traffic, or restrict fonts to uploaded or self-hosted files.
- ASVS 5.0 V1.3.6 + V13.2.4/V13.2.5 + V15.3.2 [P3, N/A today]: the server makes no outbound requests; enforce that at the OS level (systemd IPAddressDeny=any, IPAddressAllow=localhost). Any future URL-fetching feature needs a scheme and host allowlist, blocking of private addresses after DNS resolution, and no redirect following.
- ASVS 5.0 V1.2.10 [P3, PARTIAL]: the CSV export's inert() should also neutralize a leading NUL (0x00) character.
- ASVS 5.0 V11.4.2 (OWASP Password Storage CS) [P1, PARTIAL, auth track]: the node:crypto scrypt defaults (N=16384) are below OWASP's minimum of N=2^17. Migrate to Argon2id via node:crypto argon2 (at least 19 MiB memory, 2 iterations, parallelism 1) and rehash on login.
- Keep, with regression tests (DONE):
- parameterized node:sqlite statements (V1.2.4);
- zod at every trust boundary, with unknown keys stripped (V2.2.1, V15.3.3);
- React escaping, React 19 blocking of javascript: URLs, and server-side http(s) URL validation (V1.2.2, V3.2.2);
- an embed iframe sandbox without allow-same-origin for same-origin URLs (V3.2.1);
- no CORS (V3.4.2);
- COOP/CORP same-origin (V3.4.8, V3.5.8) and Referrer-Policy same-origin (V3.4.5);
- random server-side upload filenames and no server-side execution of uploads (V5.3.1/V5.3.2);
- generic 500 responses (V16.5.1);
- TRACE rejected, no directory listing, no version headers (V13.4.3/V13.4.4/V13.4.6);
- kickModerator closing open streams on account deletion or password change (V7.4.2).

### Fontes

- https://github.com/OWASP/ASVS/tree/v5.0.0/5.0/en
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x13-V4-API-and-Web-Service.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x14-V5-File-Handling.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x22-V13-Configuration.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x23-V14-Data-Protection.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x24-V15-Secure-Coding-and-Architecture.md
- https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/NodeJS_Docker_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://hono.dev/docs/middleware/builtin/csrf
- https://github.com/honojs/hono/security/advisories
- https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7
- https://github.com/honojs/node-server/security/advisories
- https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f
- https://osv.dev/vulnerability/CVE-2024-48913
- https://github.com/vitejs/vite/security/advisories
- https://web.dev/articles/fetch-metadata
- https://pkg.go.dev/net/http#CrossOriginProtection
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
- https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://caddyserver.com/docs/caddyfile/directives/log
- https://nodejs.org/en/learn/getting-started/security-best-practices
- https://nodejs.org/en/blog/vulnerability/july-2026-security-releases
- https://nodejs.org/dist/index.json
- https://nodejs.org/docs/latest-v24.x/api/permissions.html
- https://www.herodevs.com/blog-posts/node-js-july-2026-security-release-11-cves-node-18-and-20-eol
- https://pnpm.io/blog/releases/11.0
- https://pnpm.io/settings/dependency-resolution
- https://pnpm.io/settings/build
- https://honohub.dev/docs/rate-limiter
- https://github.com/rhinobase/hono-rate-limiter
- https://express-rate-limit.mintlify.app/reference/configuration
- https://pages.nist.gov/800-63-4/sp800-63b/session/
- https://pages.nist.gov/800-63-4/sp800-63b/aal/
- local source: /Users/joaovitorborgesdasilvamatias/Documents/dev/deck.slides/node_modules/hono/dist/middleware/csrf/index.js
- local source: /Users/joaovitorborgesdasilvamatias/Documents/dev/deck.slides/node_modules/hono/dist/middleware/secure-headers/secure-headers.js
- local source: /Users/joaovitorborgesdasilvamatias/Documents/dev/deck.slides/node_modules/@hono/node-server/dist/index.mjs and serve-static.mjs
- local source: /Users/joaovitorborgesdasilvamatias/Documents/dev/deck.slides/node_modules/@base-ui/react/docs/react/utils/csp-provider.md
- local source: /Users/joaovitorborgesdasilvamatias/Documents/dev/deck.slides/node_modules/uqr/dist/index.mjs (renderSVG)
