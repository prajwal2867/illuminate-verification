# Online Event Verification System

## Current-build audit and development plan

**Review date:** 2026-09-11
**Scope:** `server.js`, `app.js`, `index.html`, `styles.css`, `package.json`, and the local SQLite data directory.

## 1. Executive summary

The project has moved beyond a static prototype. It now has a Node HTTP server, SQLite persistence, server-side registration, generated QR payloads, an admin login, a registration list, pass removal, manual verification, and a browser camera path.

It is still not ready for a real event. The main problem is not the visual experience; it is that the system has not yet established a complete, durable trust model between attendee data, issued passes, admin actions, and entry decisions. The highest-risk gaps are:

- A real admin password is stored in source code and compared using a fast SHA-256 hash.
- Sessions exist only in process memory and have no server-side role or event scope.
- The QR secret is encrypted in the database, but the default encryption key is public in source.
- Check-in is not atomic, so concurrent scans can both be accepted.
- Pass expiry, event timing, approval state, and audit actor identity are not enforced.
- The admin endpoint returns every attendee's full personal data and regenerated QR image in one unpaginated response.
- The attendee only gets a pass while that browser page remains available; refresh or loss of the QR requires a new support path.

The recommended direction is a small single-application system with one public registration flow and one protected admin control room. Keep the user experience short and forgiving, but make the server the only authority for identity, pass lifecycle, permissions, and check-in.

### Implementation status: first slice completed

- Admin credentials now come from environment configuration and use scrypt verification; the source-held test credential is gone.
- Admin sessions and admin users are persisted in SQLite with session expiry and logout revocation.
- Registration, login, removal, and check-in audit records can identify the acting administrator where applicable.
- QR payloads are validated for version, event, and token shape; pass expiry and event timing are enforced.
- Check-in now uses an atomic conditional update plus a unique check-in record, preventing concurrent double acceptance.
- Configured origin checks, CSP, and safer API/static response headers were added.
- `.env.example` and `npm run admin:hash` document the required secret provisioning path.

The next implementation slice is data minimization and operational completeness: paginated admin results, explicit revoke/reissue controls, an admin session restore endpoint, structured migrations, and focused automated concurrency/security tests.

## 2. What the current build actually does

### Public attendee flow

1. The browser validates name, email, phone, and Illuminate ID.
2. The browser posts the values to `POST /api/events/illuminate-2026/registrations`.
3. The server normalizes values, applies a five-attempt-per-minute in-memory limiter, checks a unique Illuminate ID, and writes a registration, pass, encrypted QR payload, and audit row in a transaction.
4. The server returns the attendee name, pass ID, and a QR data URL.
5. The browser hides the form and displays the QR only after the user clicks “Get QR code”.

### Admin flow

1. The browser posts credentials to `POST /api/admin/login`.
2. The server checks a hard-coded account, creates an in-memory session, and sets an HttpOnly SameSite cookie.
3. The dashboard loads all non-removed registrations, including contact information and generated QR images.
4. An administrator can remove a registration with a fixed reason, or verify a QR value or pass ID.
5. Verification marks an active pass as used and writes an audit row.

### What is not implemented

- Multiple events or event selection.
- Admin account provisioning, password rotation, password reset, or roles.
- Approval/rejection workflow.
- Pass reissue or explicit revocation action separate from removal.
- Expiry enforcement, event-window enforcement, or check-in history UI.
- Search, filters, pagination, export, reporting, or dashboard counts.
- Durable session storage or session revocation after a process restart.
- Email/SMS recovery, attendee lookup, or a safe pass recovery journey.
- Automated tests, migrations, backups, deployment configuration, monitoring, or CI.

## 3. Findings and risks

### Critical: admin credentials are committed to source

`server.js` contains `test@example.com` and `28672867` in `PREDEFINED_ADMIN_ACCOUNTS`. Anyone with the repository, browser deployment bundle, backup, or server access can obtain the credential. The value is hashed only at login with SHA-256; this is not a password hashing scheme designed to resist guessing.

**Required fix:** provision administrators outside source control, store an Argon2id or bcrypt password hash, use generic login errors, throttle attempts, and rotate the exposed development credential before any shared or production use.

### Critical: check-in is not atomic

`handleVerifyPass` first reads an active pass, then later executes `UPDATE passes SET status = 'used'`. Two requests can read `active` before either update completes, causing two successful entries.

**Required fix:** perform a conditional update inside a transaction, for example update only where `status = 'active'`, then accept only when exactly one row changed. Insert a check-in row in the same transaction and enforce a uniqueness rule for the pass/event pair.

### Critical: the encryption fallback defeats the QR protection

The QR payload is encrypted at rest, but `PASS_ENCRYPTION_KEY` falls back to the literal string `local-development-pass-encryption-key`. Anyone who can copy the database and read the source can decrypt stored QR tokens. This is especially sensitive because the admin endpoint regenerates every QR image on every list request.

**Required fix:** fail startup when the production key is missing or too weak, keep it in deployment secret storage, rotate it deliberately, and avoid retaining recoverable raw QR tokens unless the product genuinely needs server-side QR re-display.

### High: sessions are not durable or scalable

The `sessions` map disappears on restart, cannot be shared by multiple processes, has no explicit invalidation except local logout, and has no session rotation or idle timeout. There is no stored admin user ID, role, or event scope in the session.

**Required fix:** use a database-backed or trusted external session store, rotate the session ID after login, store an admin user reference and permissions, enforce absolute and idle expiry, and revoke sessions on logout or credential compromise.

### High: CSRF and browser security controls are incomplete

Cookie-authenticated state-changing requests have no CSRF token or equivalent origin policy. CORS accepts any localhost port, and there is no Content Security Policy, frame protection, HSTS, or cache policy for the HTML. Inline SVG and remote Google Fonts also complicate a strict CSP.

**Required fix:** serve the UI and API from one origin where practical, validate `Origin`/`Referer` for mutations, add CSRF protection if cross-origin operation remains possible, define a restrictive CSP, and add security headers centrally.

### High: pass and event rules are incomplete

The schema has `expires_at`, event start/end fields, and pass statuses, but registration never sets an expiry and verification never checks expiry or event timing. Verification accepts a pass ID as well as the secret QR value, so possession of a displayed pass ID is enough to attempt entry. The QR parser takes the last dot-separated value without validating the payload version or event identifier.

**Required fix:** define the event and pass policy first, set expiry at issuance, validate payload structure and event ID, enforce event window and registration status, and decide whether manual pass IDs are an intentional staff fallback. If retained, require an additional staff-visible identity check and rate-limit attempts.

### High: personal data is overexposed in the admin API

Every registration request returns all names, email addresses, phone numbers, Illuminate IDs, pass IDs, and QR images. There is no pagination, filtering, redaction, field-level permission, export control, or retention process. Audit rows do not identify the admin actor or record a reason in structured fields.

**Required fix:** return summary fields by default, redact phone/email where not needed, load sensitive details on demand, paginate and filter, add admin identity and structured metadata to audit records, and define retention/deletion rules.

### High: database integrity and operations are fragile

The duplicate check occurs before the registration transaction. Concurrent requests can collide on the unique index and become a generic 500 rather than a clear duplicate response. The database is created at runtime with ad hoc `ALTER TABLE` logic and no migration history. There is no backup, restore test, graceful shutdown, or health check.

**Required fix:** rely on the unique constraint inside a transaction and translate constraint errors to 409, introduce versioned migrations, enable a deliberate SQLite journal/concurrency configuration, add backup/restore procedures, and provide health/readiness endpoints.

### Medium: abuse controls are local and easy to exhaust

Registration rate limiting is an unbounded in-memory map keyed by the direct socket address. It is lost on restart, unsuitable behind a proxy without trusted client-IP handling, and the five-attempt window is shared across all events because the event is hard-coded. Login has no throttling at all.

**Required fix:** add bounded, observable rate limiting for registration, login, verification, and removal; use a trusted proxy configuration; add bot protection only if abuse warrants it; never rely on rate limits as the duplicate-data control.

### Medium: the client has reliability and privacy gaps

- The registration submit button is declared but never disabled during the request, so repeated clicks can create competing requests.
- A refresh loses the only client-held QR data URL; the user is told to save it but is not offered recovery.
- Network failures show a generic message with no safe retry or duplicate-result recovery.
- The admin table loads the entire dataset and has no search, empty/error retry, session-expired explanation, or loading skeleton.
- The removal action is labelled “Remove fraud” and always sends “Removed by administrator”, which is accusatory and prevents a meaningful audit reason.
- Camera scanning depends on `BarcodeDetector`, which is not available in every supported browser; permission denial and repeated detection need clearer states.

### Medium: accessibility and modal behavior need completion

The project has labels, live regions, visible focus styling, and reduced-motion rules. The admin overlay is not a complete modal: it has no backdrop behavior, focus trap, inert background, or restoration of the previously focused element in every path. The dashboard table is very wide on mobile and exposes sensitive information without a compact alternative.

### Low: maintainability and delivery gaps

The server, routing, schema creation, authentication, and business rules are all in one file. There are no automated tests, no `.env.example`, no dependency audit, no structured logger, no error monitoring, and no deployment runbook. The package has no `engines` declaration even though it requires a recent Node release for `node:sqlite`.

## 4. Target trust model

The browser is a convenience layer. The server and database are the source of truth.

### Attendee data flow

1. The attendee completes a short form with only fields required for identification and contact.
2. The client gives immediate, friendly validation; the server repeats normalization and validation.
3. The server confirms the event is open, enforces the event-specific uniqueness rule, and creates the registration and pass in one transaction.
4. The server generates a cryptographically random opaque token. Only a hash is used for lookup. The QR payload contains the version, event reference, and token, never PII.
5. The attendee sees a clear success screen with pass ID, expiry, download/print action, and a recovery reference.

### Admin data flow

1. The admin authenticates against a stored password hash over HTTPS.
2. The server creates a rotated, durable session containing admin ID, role, and event scope.
3. The dashboard requests the smallest data set needed for the current view.
4. Every mutation checks authentication, authorization, current state, input, and event ownership on the server.
5. Every security-sensitive action writes an audit event with actor, action, target, reason, timestamp, and result.

### Entry data flow

1. The camera decodes locally; raw camera frames are not uploaded.
2. The browser sends the opaque QR token to the same verification endpoint as manual fallback.
3. The server validates payload version, event, token hash, pass status, registration status, expiry, and event window.
4. An atomic transaction records one accepted check-in. Replays return `already_used`; invalid, revoked, expired, and wrong-event values return distinct operational results without exposing unnecessary PII.

## 5. Recommended data model

Use explicit tables and constraints. Keep the first release single-event capable but model `event_id` now so the system does not need a risky rewrite later.

### Event

`id`, `name`, `starts_at`, `ends_at`, `registration_opens_at`, `registration_closes_at`, `status`, `created_at`, `updated_at`

Statuses: `draft`, `open`, `closed`, `archived`.

### Registration

`id`, `event_id`, `name`, `email_normalized`, `phone`, `illuminate_id_normalized`, `status`, `created_at`, `updated_at`, `removed_at`, `removed_by`, `removal_reason`

Statuses: `pending`, `approved`, `rejected`, `removed`.

Constraint: unique `(event_id, illuminate_id_normalized)` for records that are not removed, according to the chosen retention policy.

### Pass

`id`, `registration_id`, `event_id`, `token_hash`, `status`, `issued_at`, `expires_at`, `revoked_at`, `revoked_by`, `revocation_reason`, `used_at`

Statuses: `active`, `used`, `revoked`, `expired`.

Do not store a decryptable QR payload unless pass re-display is a confirmed requirement. Prefer issuing a new pass through an authenticated recovery flow.

### CheckIn

`id`, `event_id`, `pass_id`, `result`, `checked_in_at`, `admin_user_id`, `device_id` or a privacy-limited device reference

Constraint: one accepted check-in per pass/event. Store rejected attempts only when useful for abuse investigation, and never store raw QR tokens.

### AdminUser and Session

Admin: `id`, `email`, `password_hash`, `display_name`, `role`, `active`, `last_login_at`, `created_at`, `updated_at`.

Session: `id_hash`, `admin_user_id`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`.

### AuditLog

`id`, `actor_admin_id`, `action`, `entity_type`, `entity_id`, `reason`, `metadata_json`, `created_at`, `ip_prefix`.

Never place passwords, raw tokens, or unnecessary full personal data in audit metadata.

## 6. State rules that must be explicit

### Registration

`pending -> approved`
`pending -> rejected`
`approved -> removed`
`rejected -> removed`

If registration is automatic for this event, use `approved` directly but document that decision. Removing a registration must revoke its active pass and preserve an audit trail.

### Pass

`active -> used`
`active -> revoked`
`active -> expired`

Only the server may transition a pass. Reissuing must revoke the old pass before or in the same transaction as issuing the replacement. A used pass must not become active again.

### Verification result contract

Use stable machine results and friendly UI messages:

`accepted`, `already_used`, `revoked`, `expired`, `not_found`, `wrong_event`, `registration_not_eligible`, `rate_limited`, `service_unavailable`.

The UI should show the attendee name only after a valid match and should avoid returning email/phone for failed attempts.

## 7. API shape for the first production-ready version

All request bodies, path values, query values, content types, and maximum lengths must be validated on the server.

| Endpoint | Purpose | Protection |
|---|---|---|
| `POST /api/events/:eventId/registrations` | Create attendee registration and pass | Public, rate-limited, idempotent duplicate behavior |
| `GET /api/events/:eventId/pass/:recoveryRef` | Recover a pass without exposing broad records | Public only with a high-entropy recovery secret and throttling |
| `POST /api/admin/login` | Start an admin session | Public, strongly rate-limited |
| `POST /api/admin/logout` | Revoke current session | Authenticated, CSRF/origin protected |
| `GET /api/admin/me` | Restore session state after refresh | Authenticated |
| `GET /api/admin/events/:eventId/registrations` | Paginated summary list | Authenticated and event-scoped |
| `GET /api/admin/registrations/:id` | Load permitted details on demand | Authenticated and authorized |
| `POST /api/admin/registrations/:id/remove` | Soft-remove with reason | Authenticated, reason required, audited |
| `POST /api/admin/passes/:id/revoke` | Revoke a pass | Authenticated, reason required, audited |
| `POST /api/admin/passes/:id/reissue` | Revoke and issue replacement | Authenticated, audited |
| `POST /api/admin/events/:eventId/check-ins` | Verify QR/manual fallback atomically | Authenticated, rate-limited, audited |
| `GET /api/admin/audit-logs` | Review administrative history | Authenticated, paginated |
| `GET /health` | Liveness/readiness check | No sensitive details |

## 8. User experience rules

### Attendee

- Keep four required fields unless the event owner proves another field is necessary.
- Normalize harmless formatting automatically and explain the required Illuminate ID format.
- Disable submit while the request is active and preserve values after recoverable errors.
- Treat a duplicate as a helpful recovery state: explain that the ID is already registered and offer pass recovery/support rather than asking the user to start over.
- On success, show the pass immediately, include expiry and event name, and provide download/print plus a recovery reference.
- Make the privacy notice truthful: state purpose, retention period, support contact, and who can access the data.

### Admin

- Open on a concise summary: total registrations, active passes, used passes, and exceptions.
- Search by Illuminate ID, pass ID, or name; paginate results; load full contact data only when needed.
- Use neutral labels such as “Remove registration” and require a reason in a confirmation dialog.
- Make verification a single focused workflow with camera permission guidance, manual fallback, clear color and text states, and a retry action.
- Show session expiry and network errors as recoverable states instead of silently returning to the public form.
- Keep keyboard navigation, focus restoration, live announcements, contrast, and mobile scanning usable.

## 9. Phased development plan

### Phase 0: decisions and containment

- Rotate and remove the exposed admin credential from source.
- Set the event identity, registration policy, approval policy, entry window, expiry, one-entry rule, support contact, and retention period.
- Decide whether pass recovery is email-based, reference-based, or staff-assisted.
- Treat the current local database as development data only; do not use it for a live event.
- Add `.env.example` with required non-secret names and document Node version.

**Exit criteria:** written business rules, no production secret in source, and an agreed privacy/retention statement.

### Phase 1: backend foundation

- Split database setup, validation, authentication, pass logic, and routes into testable modules.
- Add versioned migrations and seed only a development event/admin.
- Add environment validation; fail startup for missing production secrets.
- Add structured errors, request IDs, security headers, trusted proxy configuration, body/content limits, and graceful shutdown.
- Add a durable session store and password hashing.

**Exit criteria:** a clean checkout starts with documented prerequisites, migrations are repeatable, and an unauthenticated request cannot access admin data.

### Phase 2: trustworthy registration

- Implement strict server schemas and normalization.
- Make duplicate handling constraint-based and return a stable 409 result.
- Add idempotency or a safe duplicate-submit strategy.
- Issue opaque token hashes and a real QR payload without PII.
- Implement a recovery path and truthful privacy copy.

**Exit criteria:** refresh/retry cannot create two active passes for one attendee, no raw token is stored, and the attendee can recover without contacting a developer.

### Phase 3: admin controls and data minimization

- Replace hard-coded account with provisioned admin users and roles.
- Add login throttling, session rotation, logout revocation, CSRF/origin protection, and `GET /api/admin/me`.
- Add paginated/searchable registration summaries and on-demand details.
- Add explicit remove, revoke, reissue, and approval actions with structured reasons.
- Record actor, target, result, and timestamp in the audit log.

**Exit criteria:** every admin mutation is authorized, reasoned, auditable, and scoped to the selected event.

### Phase 4: correct check-in

- Validate QR version/event/token format.
- Enforce registration eligibility, pass expiry, event window, revocation, and used state.
- Replace read-then-update with one atomic transaction and uniqueness constraints.
- Add camera fallback behavior and retain manual entry through the same endpoint.
- Show safe, distinct results and only the minimum attendee detail needed at the gate.

**Exit criteria:** concurrent attempts produce at most one accepted entry; replay, expired, revoked, wrong-event, and invalid passes are deterministic and tested.

### Phase 5: operations, privacy, and launch

- Configure HTTPS, backups, restore rehearsal, error monitoring, and dependency updates.
- Add retention purge tooling with an approval trail.
- Test on the real phones, browsers, network, lighting, and event-day staff workflow.
- Run security and accessibility checks, then document incident response for leaked passes, compromised admin accounts, and database failure.

**Exit criteria:** the team can operate the event without developer intervention and can recover from the most likely failures.

## 10. Test plan

### Business and data integrity

- Field normalization, maximum lengths, invalid formats, and Unicode handling.
- Duplicate registration under sequential and concurrent requests.
- Transaction rollback when pass or audit creation fails.
- Registration, pass, and event state-transition matrix.
- Expiry and event-window boundaries, including timezone behavior.
- Pass reissue and revocation behavior.

### Authentication and authorization

- Password hash verification and generic failure responses.
- Login throttling and session expiry/revocation.
- CSRF/origin checks and cookie attributes.
- Every admin route with no cookie, expired cookie, wrong role, and wrong event.
- IDOR attempts against another registration or pass.

### Check-in

- Valid QR, valid manual fallback, invalid token, malformed token, wrong event, expired, revoked, removed, and already-used cases.
- Concurrent scans of one pass.
- No PII in QR payloads, logs, errors, or failed verification responses.

### Browser and accessibility

- Registration success, duplicate, network failure, refresh/recovery, and repeated submit.
- Admin login/logout/session expiry and all mutation confirmations.
- Camera supported, unsupported, denied, unavailable, and manual fallback paths.
- Mobile layout, keyboard-only navigation, focus trap/restoration, screen-reader announcements, and reduced motion.

## 11. Launch checklist

- [ ] Development credential is rotated and absent from repository and deployed bundles.
- [ ] Production encryption/session secrets are present only in secret storage.
- [ ] Admin passwords are Argon2id/bcrypt hashes, not plaintext or fast hashes.
- [ ] HTTPS, secure cookies, CSRF/origin protection, CSP, HSTS, and cache headers are verified.
- [ ] Database migrations, backup, restore, and retention procedure are tested.
- [ ] Registration duplicate behavior and check-in concurrency tests pass.
- [ ] Admin actions and check-in results appear in an actor-attributed audit log.
- [ ] QR payload contains no personal data and leaked/revoked passes cannot enter.
- [ ] Registration and recovery are rehearsed on mobile.
- [ ] Event staff know the manual fallback and the incident/support process.

## 12. Best first implementation slice

The first implementation milestone should establish the security boundary and atomic entry rule:

1. Remove source credentials and introduce environment-backed admin provisioning with a strong password hash.
2. Add durable sessions, login throttling, CSRF/origin protection, and centralized security headers.
3. Add `CheckIn`, `AdminUser`, and structured `AuditLog` fields through a migration.
4. Rewrite verification as an atomic conditional transaction with expiry and event checks.
5. Add focused tests for concurrent scans, duplicate registrations, authorization, and secret/PII leakage.

This slice makes the existing UI safer without requiring a visual rewrite. Once the server can be trusted, the remaining work can improve recovery, search, admin ergonomics, and event-day polish without changing the core data contract.
