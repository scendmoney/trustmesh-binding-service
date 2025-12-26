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

### `GET /health`
Returns service status.
```json
{ "ok": true, "service": "trustmesh-binding-service", "version": "1.0.0" }
```

### `GET /v1/resolve`
Resolve an EVM address to a Hedera Account ID.
**Query Params:** `worldId`, `evm`
```json
// Found
{
  "worldId": "labworld1",
  "evm": "0x123...",
  "hederaAccountId": "0.0.123",
  "bindingEventId": "0.0.999:5",
  "updatedAt": 1700000000000
}

// Not Found
{
  "worldId": "labworld1",
  "evm": "0x123...",
  "hederaAccountId": null,
  "bindingEventId": null,
  "updatedAt": null
}
```

### `POST /v1/bind`
Create a new identity binding (Oracle Write).
**Headers:** `Content-Type: application/json`
**Body:**
```json
{
  "worldId": "labworld1",
  "evmAddress": "0x123...",
  "hederaAccountId": "0.0.456",
  "proof": {
    "type": "otp_attestation",
    "value": "your-shared-secret"
  }
}
```

## 🔒 Security
- **Rate Limiting:** Global 60 req/min, Write 10 req/min.
- **Fail Safe:** Returns `null` on resolution failure, does not crash.
- **Oracle Pattern:** Only the server holds the Hedera Operator Key.

## 🌍 Deployment
Designed for `binding.trustmesh.app`.
- Set `NODE_ENV=production`.
- Ensure all ENV vars are injected.
- Expose PORT 3002.
