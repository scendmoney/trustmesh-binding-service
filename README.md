
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

## 🔒 Security
- **Rate Limiting:** Global 60 req/min, Write 10 req/min.
- **Fail Safe:** Returns `null` on resolution failure, does not crash.
- **Oracle Pattern:** Only the server holds the Hedera Operator Key.
- **Magic JWT:** Disabled by default. Set `MAGIC_JWT_ENABLED=true` only if proper verification is added.

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
    - `IDENTITY_TOPIC_ID`
    - `BINDING_SHARED_SECRET`
    - `RESOLVE_MAX_PAGES` (default 25)
    - `MAGIC_JWT_ENABLED` (default false)

### Docker / VPS
- Set `NODE_ENV=production`.
- Ensure all ENV vars are injected.
- Expose PORT 3002.
