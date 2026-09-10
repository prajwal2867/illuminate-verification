# Online Event Verification System

## Development Plan and Security Review

**Review date:** 2026-09-10  
**Current build:** static HTML/CSS/JavaScript prototype

## 1. Executive Summary

The current build is a useful visual and interaction prototype, but it is not an event verification system yet. It has no server, database, durable user records, real authentication, real QR codes, or trusted verification boundary. All security-sensitive decisions are made in the browser, so any visitor can inspect or change them.

The recommended next step is a small full-stack TypeScript application with a public registration flow and a protected admin area backed by PostgreSQL. The public experience should remain a short form followed by a clear pass screen. The admin experience should expose only the actions that the logged-in administrator is authorized to perform, and every state-changing action should be validated and audited on the server.

## 2. Current State

### What works in the prototype

- Responsive registration form with client-side validation.
- Success screen that displays the submitted name and Illuminate ID.
- A visual QR-like grid is generated in the browser.
- Admin login, dashboard tabs, a registration table, and manual pass input are visually represented.
- Basic keyboard focus handling, labels, live status messages, and reduced-motion styling are present.

### What is only simulated

- Registration is never sent anywhere and disappears on refresh.
- The QR output is a fixed decorative pattern, not an encoded QR payload.
- The admin account is hard-coded in `app.js`.
- The dashboard records are hard-coded in `index.html`.
- Pass verification compares against two hard-coded IDs in `app.js`.
- The scanner is a visual frame plus a manual text field; it does not access a camera.
- Logout only changes visible sections and does not end a session.
- No delete, reject, accept, resend, search, export, or audit action is implemented.

### Project boundary observed

The project contains only `index.html`, `styles.css`, `app.js`, an SVG asset, and a requirements note. There is no package manifest, backend, database schema, test suite, environment configuration, or deployment configuration.

## 3. Findings and Risks

### Critical: authentication can be bypassed

The email and password are shipped to every browser in `app.js`. Anyone can read them, call the dashboard code directly, or edit the JavaScript and HTML. The current login is a display toggle, not authentication.

**Required correction:** authenticate on the server, hash passwords with Argon2id, use secure HttpOnly sessions, and authorize every admin API request server-side.

### Critical: registration and verification are forgeable

The browser decides which details are accepted and which pass IDs are valid. A user can change the code in DevTools, submit arbitrary data, mark any pass as verified, or call UI functions directly.

**Required correction:** validate and normalize all input on the server. Look up the registration and pass in the database. Never trust a status, identity, or permission sent by the browser.

### Critical: there is no data durability or integrity

There is no database or API. User data cannot be reliably retrieved by an admin, and two browsers cannot share the same registrations.

**Required correction:** persist registrations, passes, check-ins, admin users, and audit events in PostgreSQL with constraints and transactions.

### High: the QR code is not a QR code

The displayed grid is a fixed visual pattern and does not encode a unique, verifiable credential. It can be copied and cannot be revoked or checked against a record.

**Required correction:** generate a QR code containing an opaque random pass token or a signed pass reference. Store only a hash of the secret token. Do not put name, email, phone, or other personal data in the QR payload.

### High: replay and duplicate entry are not controlled

There is no check-in record, event boundary, expiry, revocation, or atomic duplicate check. A screenshot could be reused indefinitely.

**Required correction:** use an atomic server transaction that validates the pass, records the check-in, and returns a clear result such as `accepted`, `already_used`, `revoked`, `expired`, or `not_found`.

### High: privacy and abuse controls are missing

Names, emails, and phone numbers are personal data. There is no consent text, retention policy, access log, rate limiting, bot protection, or deletion process. Public registration also permits spam and resource exhaustion.

**Required correction:** collect only required fields, publish a privacy notice, rate-limit registration and login endpoints, add CAPTCHA or a managed bot challenge when abuse appears, and define retention/deletion rules.

### Medium: client-side validation is incomplete

Validation checks format only, accepts arbitrary Illuminate IDs, does not normalize consistently, and contains minor copy defects such as `Please  full name.`. Client validation must remain a usability aid, not a security control.

### Medium: UI and accessibility gaps

- Inline `onclick` handlers duplicate JavaScript event listeners and make behavior harder to audit.
- The overlay is not a true modal: focus is not trapped and background content is not inert.
- The dashboard table is static and has no loading, empty, error, pagination, or permission states.
- The scanner does not handle camera permission, unsupported devices, lighting, or failure states.
- The success path does not provide a recovery path after refresh or lost QR access.
- External Google Fonts add a third-party request and may conflict with a strict content security policy.

### Low: operational gaps

There are no automated tests, error monitoring, dependency management, backups, migration strategy, health checks, security headers, or CI checks. The visual design is a good starting point, but production reliability is currently unmeasured.

## 4. Recommended Production Stack

Use one deployable TypeScript application initially. This keeps the public flow and admin controls close together and avoids premature microservices.

| Area | Recommendation | Reason |
|---|---|---|
| Web application | Next.js App Router + TypeScript | One application for public pages, protected admin pages, and server route handlers |
| UI | React + existing visual direction, with CSS Modules or a small global stylesheet | Preserves the simple form experience without adding a heavy component dependency |
| Validation | Zod shared between forms and server handlers | One explicit schema for normalization and validation |
| Database | PostgreSQL | Strong constraints, transactions, indexes, and reliable relational reporting |
| ORM/migrations | Prisma or Drizzle; choose one and commit migrations | Typed queries and reviewable schema changes |
| Authentication | Auth.js or an equivalent server-side session library with database sessions | Secure session lifecycle and role-aware access control |
| Password hashing | Argon2id | Modern password hashing resistant to offline cracking |
| Session storage | PostgreSQL initially; Redis only if scale requires it | Fewer moving parts for a small event system |
| Rate limiting | Redis-backed limiter in production, with an edge/provider limiter as a second layer | Protects login, registration, and verification endpoints |
| QR generation | `qrcode` on the server or client for display | Produces a standards-compliant QR image from a server-issued payload |
| QR scanning | `@zxing/browser` or a maintained browser QR library | Camera scanning with graceful manual fallback |
| Email | Transactional provider such as Postmark, Resend, or SES | Registration confirmation and admin recovery without building mail delivery |
| Hosting | Managed Next.js host or container platform + managed PostgreSQL | HTTPS, environment secrets, backups, and simple deployment |
| Observability | Structured server logs plus Sentry/OpenTelemetry-compatible error tracking | Detects failed verification and operational abuse |
| Testing | Vitest, React Testing Library, Playwright, and OWASP-oriented API tests | Covers business rules, UI flow, browser behavior, and abuse cases |
| CI/CD | GitHub Actions: typecheck, lint, unit tests, build, migration check, dependency audit | Prevents unsafe changes from reaching production |

Do not add a blockchain, microservices, or a custom cryptographic protocol. They would increase complexity without solving the actual problems in this application.

## 5. Domain Model and Trusted Data Flow

### Core entities

**Event**

- `id`, `name`, `startsAt`, `endsAt`, `status`, `createdAt`

**Registration**

- `id`, `eventId`, `name`, `email`, `phone`, `illuminateId`
- `status`: `pending`, `approved`, `rejected`, `deleted`
- `createdAt`, `updatedAt`, `deletedAt`
- Unique constraint on `(eventId, illuminateId)`

**Pass**

- `id`, `registrationId`, `tokenHash`
- `status`: `active`, `revoked`, `expired`, `used`
- `issuedAt`, `expiresAt`, `usedAt`
- Never store the raw QR secret after issuance

**CheckIn**

- `id`, `passId`, `eventId`, `result`, `checkedInAt`, `adminUserId`, `deviceMetadata`
- Unique constraint on `passId` if one entry per pass is required

**AdminUser**

- `id`, `email`, `passwordHash`, `displayName`, `role`, `status`, `lastLoginAt`
- Roles: `admin` and `scanner`; add finer permissions only when needed

**AuditLog**

- `id`, `actorId`, `action`, `entityType`, `entityId`, `metadata`, `ipHash`, `createdAt`
- Record login outcomes, registration decisions, pass issuance/revocation, deletion, and check-in results

### Registration flow

1. The attendee opens the public event registration page.
2. The client performs friendly validation and submits to `POST /api/events/:eventId/registrations`.
3. The server validates with Zod, normalizes email and ID, checks the event, applies rate limits, and rejects duplicate IDs.
4. The server creates a registration and pass in one transaction.
5. The server generates a cryptographically random token, stores only its hash, and returns a one-time pass retrieval response.
6. The client renders a real QR code containing a non-PII payload.
7. The user receives a confirmation reference or email so the pass can be recovered without exposing the full database record.

### Admin flow

1. Admin submits credentials to the server over HTTPS.
2. The server verifies Argon2id, applies login rate limits, records the result, and creates a secure session.
3. The dashboard fetches data through authenticated API requests. It never embeds registration records in HTML or JavaScript.
4. The server checks the session role on every read and mutation.
5. Approve, reject, revoke, delete, and check-in operations use explicit endpoints and write audit logs.
6. Logout invalidates the server session and clears the cookie.

### Check-in flow

1. The scanner decodes the QR payload locally; camera data is not uploaded.
2. The client sends the opaque token to `POST /api/events/:eventId/check-ins`.
3. The server hashes the token, finds the matching active pass, confirms event and expiry, and performs an atomic check-in transaction.
4. The response gives only the minimum needed result: accepted, already used, revoked, expired, or invalid.
5. The admin UI shows a strong visual and text result, with a manual ID fallback that uses the same server endpoint.

## 6. State Machine

### Registration states

`pending -> approved -> deleted`

`pending -> rejected -> deleted`

Deletion should normally be a soft delete so audit history and duplicate prevention remain intact. Only a restricted data-retention job should permanently purge personal data.

### Pass states

`active -> used`

`active -> revoked`

`active -> expired`

Only the server may transition a pass. A revoked, expired, or used pass must never be accepted by the scanner.

### Admin actions

- `GET registrations`: view paginated, filtered records; redact phone numbers by default.
- `PATCH registration`: approve or reject with a reason.
- `POST pass/reissue`: revoke the old pass, issue a new one, and audit both actions.
- `POST pass/revoke`: revoke immediately with a required reason.
- `POST check-ins`: accept or reject through the atomic verification rule.
- `DELETE registration`: soft-delete with confirmation and audit entry.
- `GET audit-log`: admin-only, paginated, read-only history.

## 7. Security Requirements

### Application and browser security

- HTTPS everywhere; redirect HTTP to HTTPS.
- Secure, HttpOnly, SameSite cookies with a narrow cookie path and short idle timeout.
- CSRF protection for cookie-authenticated state-changing requests.
- Content Security Policy with nonces or hashes; remove inline `onclick` handlers.
- `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, strict referrer policy, and HSTS after HTTPS is verified.
- Escape rendered user data; never use `innerHTML` for attendee-controlled values.
- Avoid third-party fonts or self-host them if a strict CSP is required.
- Do not expose stack traces, database errors, password-reset existence, or admin record details to public users.

### API and authorization

- Validate body, path, query, and headers on every endpoint.
- Enforce event ownership and role permissions server-side.
- Use pagination limits, maximum input lengths, request body limits, and timeouts.
- Return generic login errors to prevent account enumeration.
- Rate-limit login, registration, pass retrieval, and verification separately.
- Use idempotency keys for registration submission and check-in retries.
- Use database transactions and unique constraints as the final duplicate protection.

### Secrets and operations

- Remove the development credentials from source control immediately.
- Store secrets only in deployment secret storage and rotate them after any exposure.
- Use separate development, staging, and production databases.
- Encrypt backups, restrict database network access, and test restore procedures.
- Keep dependencies updated and run an audit in CI.
- Log security events without logging passwords, raw QR tokens, or full personal data.

## 8. UX Rules for a Simple Experience

- Keep public registration to one short page and four required fields unless the event truly needs more.
- Show inline errors near the field and preserve entered values after recoverable failures.
- On success, show a clear pass ID, real QR code, expiry, and a recovery option.
- Make the QR available again through a short-lived, authenticated recovery link or emailed confirmation; do not rely on browser memory.
- Use one scanner screen with camera permission, a manual fallback, and unmistakable result states.
- Do not make attendees understand statuses such as database IDs or internal moderation terms.
- Keep admin tables searchable and paginated; confirm destructive actions and require a reason.
- Provide loading, empty, error, offline, expired-session, and duplicate-submit states.
- Meet WCAG 2.2 AA basics: keyboard navigation, focus management, contrast, live announcements, and reduced motion.

## 9. Phased Delivery Plan

### Phase 0: security and product decisions

- Confirm whether Illuminate ID is authoritative and how it is checked.
- Confirm one event versus multiple events, pass expiry, one-entry policy, and data retention period.
- Decide whether registration is automatically approved or admin-approved.
- Define admin roles and whether email recovery is required.
- Remove demo credentials and hard-coded attendee data from the working prototype.

**Exit criteria:** signed-off state diagram, field list, retention policy, and permission matrix.

### Phase 1: foundation

- Create the Next.js TypeScript application and package scripts.
- Add environment validation, PostgreSQL connection, migrations, seed data, and CI.
- Add shared Zod schemas and structured error handling.
- Add security headers, logging, health endpoint, and dependency audit.

**Exit criteria:** clean build, migration runs in a blank database, no secrets in source, CI is green.

### Phase 2: public registration and pass issuance

- Implement event lookup and server-side registration endpoint.
- Normalize and validate attendee fields.
- Add duplicate and idempotency handling.
- Create hashed random pass tokens and real QR generation.
- Build success, recovery, expiry, and failure states.

**Exit criteria:** a registration survives refresh and can be retrieved only through an authorized recovery path; duplicate submissions do not create duplicate passes.

### Phase 3: admin authentication and dashboard

- Add admin provisioning and password hashing.
- Implement secure sessions, login throttling, logout, and session expiry.
- Replace static rows with paginated authenticated queries.
- Add role checks, redaction, approve/reject, revoke, soft-delete, and audit history.

**Exit criteria:** an unauthenticated request cannot read or mutate admin data, and every mutation has an audit record.

### Phase 4: real verification

- Add camera scanner with permission and unsupported-device handling.
- Add manual fallback using the same verification endpoint.
- Implement atomic check-in, replay detection, revocation, expiry, and clear results.

**Exit criteria:** the same active pass is accepted once, then returns `already_used`; revoked and expired passes are rejected.

### Phase 5: hardening and launch

- Run automated security tests, dependency audit, accessibility checks, and browser tests.
- Configure backups, monitoring, alerting, log retention, and incident response.
- Perform a staging event rehearsal with realistic load and poor network conditions.
- Review privacy copy, data deletion, admin onboarding, and emergency revocation procedures.

**Exit criteria:** recovery is tested, restore is tested, critical security findings are closed, and an admin can complete the event workflow without developer intervention.

## 10. Test Plan

### Unit and integration tests

- Field normalization and validation boundaries.
- Duplicate registration and idempotency behavior.
- Pass token hashing and lookup.
- Every registration and pass state transition.
- Role and event authorization matrix.
- Atomic check-in under concurrent requests.
- Generic login errors and rate-limit behavior.

### Browser tests

- Public registration to QR display.
- Refresh/recovery path.
- Admin login, logout, expired session, and unauthorized deep link.
- Approve, reject, revoke, soft-delete, and audit display.
- Scan success, duplicate scan, invalid token, revoked pass, expired pass, and manual fallback.
- Mobile viewport, keyboard-only navigation, screen-reader labels, and reduced motion.

### Security checks

- OWASP ZAP or equivalent staging scan.
- SQL injection, XSS, CSRF, IDOR, brute force, enumeration, replay, and privilege escalation tests.
- Verify that source bundles contain no passwords, raw tokens, or attendee data.
- Verify that QR payloads contain no PII.
- Verify security headers and cookie attributes in production-like deployment.

## 11. Launch Checklist

- Production credentials are provisioned through a secret manager.
- Development account is disabled or replaced with an invited admin account.
- Database backups and restore test are complete.
- HTTPS, headers, cookies, rate limits, and monitoring are verified.
- Admin permissions and audit logs are tested.
- Registration and check-in workflows are rehearsed on mobile and desktop.
- Privacy notice, retention period, and support contact are visible.
- A documented incident procedure exists for a leaked pass, compromised admin account, or database outage.

## 12. Recommended First Implementation Slice

The first code milestone should be the backend boundary, not more dashboard styling:

1. Create the application and PostgreSQL schema for `Event`, `Registration`, `Pass`, `AdminUser`, `CheckIn`, and `AuditLog`.
2. Implement `POST /api/events/:eventId/registrations` with validation, rate limiting, duplicate protection, and pass issuance.
3. Replace the static success screen with the server response and a real QR code.
4. Add integration tests proving that a second registration cannot overwrite the first and that the raw token is never stored.

This slice proves the core trust model early. The existing visual design can then be retained while each screen is connected to a real, testable source of truth.