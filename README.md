
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

No production binding or lifecycle signing key or writer is configured or
activated by this repository. Existing write paths remain unchanged and emit
legacy unsigned records. Until both evidence authorities are explicitly
configured, the endpoint reports `CAPABILITY_ABSENT`.

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
    - `RESOLVE_MAX_PAGES` (default 25)
    - `MIRROR_NODE_TIMEOUT_MS`
    - `HEDERA_ALIAS_POLL_ATTEMPTS`
    - `HEDERA_ALIAS_POLL_DELAY_MS`
    - `MAGIC_JWT_ENABLED` (default false)

### Docker / VPS
- Set `NODE_ENV=production`.
- Ensure all ENV vars are injected.
- Expose PORT 3002.
