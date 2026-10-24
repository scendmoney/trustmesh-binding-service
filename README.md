
# TrustMesh Binding Service

A dedicated, minimal identity binding oracle for the TrustMesh ecosystem.
This service resolves EVM addresses to Hedera Account IDs deterministically using HCS topics.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your Hedera credentials:
```bash
cp .env.example .env
```
*Note: `IDENTITY_TOPIC_ID` must be set to a valid HCS topic ID.*

### 3. Run Locally
```bash
pnpm dev
# Service runs on http://localhost:3002
```

## 🔌 API Endpoints
(See code or State of the Union for detailed schemas)

- `GET /health`
- `GET /v1/resolve`
- `GET /v1/status`
- `POST /v1/bind`
- `POST /v1/identity-binding/register` (authenticated, explicit-consent registration)
- `POST /v1/currentness` (authenticated, read-only, complete-history lifecycle reduction)

## 🔒 Security
- **Rate Limiting:** Global 60 req/min, Write 10 req/min.
- **Fail Safe:** Returns `null` on resolution failure, does not crash.
- **Oracle Pattern:** Only the server holds the Hedera Operator Key.
- **Magic JWT:** Disabled by default. Set `MAGIC_JWT_ENABLED=true` only if proper verification is added.

## Currentness v1

The versioned doctrine and producer contract are recorded in
[`docs/IDENTITY_CURRENTNESS_V1.md`](docs/IDENTITY_CURRENTNESS_V1.md).

`POST /v1/currentness` is a nonmutating, cache-free read. Authenticate with
`x-trustmesh-currentness-token` and send:

```json
{
  "requestVersion": "v1",
  "identity": {
    "canonicalDid": "did:example:subject",
    "stableIdentifier": "issuer:subject",
    "issuer": "https://issuer.example"
  }
}
```

The response disposition is one of `CURRENT`, `REVOKED`, `SUPERSEDED`,
`UNBOUND`, `AMBIGUOUS`, or `UNKNOWN_STALE`. It identifies the exact identity,
binding and lifecycle evidence, service version, observation validity window,
and the network/topic/sequence watermark covered by the read.
An `AMBIGUOUS` result is returned with HTTP `409` so consumers treat it as a
conflict rather than selecting a candidate.
The producer keeps these dispositions distinct; downstream consumers may map
them into their own policy categories. `serviceVersion` is the release version
from `package.json`, and `CAPABILITY_ABSENT` remains the producer failure code.

Lifecycle records use `IdentityLifecycleEventV1` from
`src/services/binding/types.ts`. They target an immutable binding reference and
carry signed authority provenance, authorization-basis/version, evidence,
schema, and exact normalization fields. `IDENTITY_SUPERSEDE` also names an exact
replacement binding. Binding/assertion and lifecycle evidence use deterministic
canonical JSON and `EIP191_SECP256K1` signatures. The reader accepts evidence
only when its signature verifies against the separately configured public key
and its key ID, payer, authority account, authorization basis, and basis version
all match policy. Unsigned legacy evidence cannot produce `CURRENT`.
Canonical DID, stable identifier, and issuer comparisons are exact under
`exact-v1`; they are not case-folded or rewritten.
Lifecycle effective time is the HCS consensus timestamp; payload timestamps do
not schedule or backdate an effect.

No production binding or lifecycle authority is designated by this repository.
The existing legacy write paths remain unchanged and emit unsigned records;
those records cannot produce `CURRENT`. The identity-registration route signs
new evidence only when the binding authority is configured and matches the
actual Hedera operator signer. Currentness still requires both binding and
lifecycle authorities to be configured.

## Identity registration v1

`POST /v1/identity-binding/register` is the explicit-consent boundary for a
Magic-authenticated representative. It uses the existing
`x-worlds-builder-service-token`; the token must be configured or the route
fails closed. Claim-facing callers must also send
`x-trustmesh-operation-owner` with the opaque reference of a durable upstream
operation record. The accepted reference is 1-200 characters and uses only
letters, digits, `.`, `_`, `:`, `/`, or `-`. WorldsBuilder operation 0034 is
the designated integration owner: it must durably retain the exact request,
consent reference, outcome, reconciliation, and claim progression. A header
assertion is not a substitute for that durable record.

The strict v1 request contains only the exact canonical DID,
stable identifier, issuer, provider-derived EVM public address, fixed purpose
`eugene.business.admin.custody`, durable consent receipt reference, idempotency
key, and request time. It accepts no email, phone, product role, World,
Organism, or founding-steward assertion.

```json
{
  "requestVersion": "v1",
  "canonicalDid": "did:magic:issuer:subject",
  "stableIdentifier": "issuer:subject",
  "issuer": "https://issuer.example",
  "evmPublicAddress": "0x1111111111111111111111111111111111111111",
  "purpose": "eugene.business.admin.custody",
  "consentReceiptRef": "cw-consent:receipt-id",
  "idempotencyKey": "registration-request-id",
  "requestedAt": "2026-10-24T18:00:00.000Z"
}
```

The route first performs a complete fresh currentness read. A current exact
binding is returned with its existing event receipt. For an unbound identity,
the service reconciles the EVM alias before it submits an `IDENTITY_ASSERT` or
provisions an account and submits an `IDENTITY_BIND`. Both event forms preserve
the exact DID, stable identifier, and issuer and carry signed
`EvidenceProvenanceV1`. The configured binding authority account and public key
must match the actual Hedera operator account and signing key. Ambiguous,
revoked, superseded, stale, unsigned, or unverifiable evidence blocks
registration. Uncertain provider or HCS outcomes return `pending`; they require
a fresh reconciliation before any recovery. A caller must treat `pending` as
terminal for that operation, persist it, and perform a separate nonmutating
currentness read. It must not invoke registration again merely as a retry. If
currentness remains unbound and the durable operation owner grants explicit
recovery authority, recovery uses a new idempotency key, the same
`x-trustmesh-operation-owner`, and
`x-trustmesh-recovery-authority: currentness-reconciled`. The service blocks a
same-process post-pending attempt without that authority; this is a guardrail,
not the durable operation record.

Completed idempotency outcomes are retained in process for 15 minutes, with a
maximum of 1,000 tracked operations. During that window, an exact same-key
retry returns the same response and changed input with the same key is blocked.
Capacity is reserved for in-flight operations, so a full registry starts no
new provider work. This cache is deliberately process-local: it provides no
cross-instance or restart durability, and the upstream operation owner must
enforce the recovery rule across those boundaries.

A `bound` result identifies the exact identity, EVM address, Hedera account,
binding event receipt, resolution source, service version, and bound time. It
does not authorize or submit a business claim. After receiving the receipt, the
consumer must separately call nonmutating `POST /v1/currentness` and require a
fresh `CURRENT` response before separately submitting the claim.

## 🌍 Deployment

### Vercel
Designed to deploy to `binding.trustmesh.app`.
1.  Import repo to Vercel.
2.  Set Framework to "Other" (or handle automatically via `api/index.ts`).
3.  Add Environment Variables:
    - `HEDERA_NETWORK` (testnet/mainnet)
    - `HEDERA_OPERATOR_ID`
    - `HEDERA_OPERATOR_KEY`
    - `MIRROR_NODE_URL`
    - `MIRROR_NODE_AUTH_TYPE` (`none`, `bearer`, or `x-api-key`)
    - `MIRROR_NODE_AUTH_TOKEN` (required when auth type is not `none`)
    - `IDENTITY_TOPIC_ID`
    - `BINDING_SHARED_SECRET`
    - `CURRENTNESS_SERVICE_TOKEN`
    - `BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID`
    - `BINDING_EVIDENCE_AUTHORITY_KEY_ID`
    - `BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY`
    - `BINDING_EVIDENCE_AUTHORIZATION_BASIS`
    - `LIFECYCLE_AUTHORITY_ACCOUNT_ID`
    - `LIFECYCLE_AUTHORITY_KEY_ID`
    - `LIFECYCLE_AUTHORITY_PUBLIC_KEY`
    - `LIFECYCLE_AUTHORIZATION_BASIS`
    - `CURRENTNESS_VALIDITY_MS` (default 30000)
    - `RESOLVE_MAX_PAGES` (default 25; integer from 1 through 50)
    - `MIRROR_NODE_TIMEOUT_MS`
    - `HEDERA_ALIAS_POLL_ATTEMPTS`
    - `HEDERA_ALIAS_POLL_DELAY_MS`
    - `MAGIC_JWT_ENABLED` (default false)

Currentness bounds each Mirror response to 1 MiB and each complete read to 8 MiB
and 5,000 messages, including the watermark response. Exceeding a bound returns
a typed `UPSTREAM_PERMANENT_FAILURE`; it does not log identity or credential
values. HTTPS is required in production and whenever Mirror authentication is
configured. HTTP is allowed only for credential-free localhost fixtures in
`NODE_ENV=test`; redirects are rejected.

### Docker / VPS
- Set `NODE_ENV=production`.
- Ensure all ENV vars are injected.
- Expose PORT 3002.
