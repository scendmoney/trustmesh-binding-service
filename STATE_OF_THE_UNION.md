# State of the Union: trustmesh-binding-service

**Date:** 2025-12-26
**Version:** 1.0.0 (Current Implementation)

---

## 1. Repo Identity & Purpose

**Canonical Description:**
A minimal, stateless identity oracle service that binds EVM addresses to Hedera Account IDs using Hedera Consensus Service (HCS) as the immutable source of truth. It provides a deterministic "resolve" API to query these bindings and a guarded "bind" API to create them.

**Primary Responsibility:**
To serve as the definitive "Identity Link" layer for TrustMesh, bridging the gap between EVM-based identities (World ID, Wallets) and Hedera's native account system without maintaining a local state database.

**Explicit Non-Responsibilities:**
*   **Identity Provider:** It does not issue or manage identities; it only links existing ones.
*   **Key Management:** It does not hold user keys, only its own Operator key for HCS submission.
*   **Authentication Authority:** It relies on upstream proofs (signatures, JWTs, OTPs) and does not implement its own auth sessions.

---

## 2. System Inventory (Current State Only)

### Annotated Directory Tree
```
/
├── src/
│   ├── index.ts              # Entry point. Setup Express, Helmet, CORS, Rate Limits.
│   ├── config.ts             # Typed Env configuration (Zod). Fails fast on missing vars.
│   ├── services/
│   │   ├── binding/
│   │   │   ├── bindingService.ts # Write Path: Proof verification -> HCS Submit.
│   │   │   ├── resolveService.ts # Read Path: Mirror Node Query -> Filter -> Cache.
│   │   │   └── types.ts          # Core type definitions.
│   │   └── hedera/
│   │       └── client.ts         # Singleton Hedera Client & Topic submission helper.
│   └── util/
└── package.json              # Key deps: @hashgraph/sdk, ethers, express, zod.
```

### Active Systems
1.  **API Server:** Node.js/Express service listening on port 3002 (default).
2.  **Hedera Interface:** Direct connection to Hedera Mainnet/Testnet via `@hashgraph/sdk` and Mirror Node REST API.

### External Dependencies
*   **Hedera Consensus Service (HCS):** The "database" for all binding events.
*   **Hedera Mirror Node:** Required for querying/resolving historical data.
*   **World ID / Magic link (Upstream):** implied proof providers (though `magic_jwt` implementation is currently a placeholder).

---

## 3. Architecture & Responsibility Boundaries

### Layer 1: API Layer (`index.ts`)
*   **Responsibility:** Request routing, input validation (Zod), rate limiting (60/min global).
*   **Boundary:** Must not contain business logic. Delegates immediately to Services.
*   **Invariants:** All write requests (`/bind`) are rate-limited stricter (10/min) than reads.

### Layer 2: Binding Service (`bindingService.ts`)
*   **Responsibility:** Validate proofs and submit immutable events to HCS.
*   **MAY:** Verify cryptographic signatures (Ethers.js) or shared secrets.
*   **MUST NOT:** Write to any local database.
*   **Trust Boundary:** The Service acts as an Oracle. It is the *only* entity authorized to write to the `IDENTITY_TOPIC_ID`.

### Layer 3: Resolve Service (`resolveService.ts`)
*   **Responsibility:** Reconstruct state by querying the Mirror Node.
*   **Mechanism:** Fetches last 100 messages from the topic, filters in-memory for the requested `worldId` + `evmAddress`.
*   **Caching:** Implements a short-lived (60s) in-memory cache to reduce Mirror Node load.

---

## 4. Canonical Data Structures & Contracts

### Core Object: `BindingEvent`
The atomic unit of state stored on HCS.
```typescript
interface BindingEvent {
    type: 'IDENTITY_BINDING'; // Discriminator
    worldId: string;          // External scope ID
    evmAddress: string;       // 0x...
    hederaAccountId: string;  // 0.0.xxx
    createdAt: number;        // Timestamp
    proofType: string;        // 'otp_attestation' | 'sig' | 'magic_jwt'
    payloadHash?: string;     // Intey check
}
```

### Frozen Fields
*   `type`: Must be `IDENTITY_BINDING`.
*   `evmAddress`: Stored as-is, but treated case-insensitively during resolution.

### Versioning
*   Currently `v1`. No schema versioning field exists in the payload, creating a potential future migration risk.

---

## 5. Runtime Execution Flows

### Flow A: Resolution (Read)
1.  **Incoming:** `GET /v1/resolve?worldId=...&evm=...`
2.  **Cache Check:** Check in-memory `Map` (Key: `worldId:evm`).
    *   *Hit:* Return cached result immediately.
3.  **Fetch:** Call Hedera Mirror Node (`/topics/:id/messages?limit=100&order=desc`).
4.  **Scan:** Iterate through messages (newest first).
    *   Decode Base64 message.
    *   Parse JSON.
    *   Match `worldId` and `evmAddress` (case-insensitive).
5.  **Result:**
    *   *Found:* Return `hederaAccountId` and `bindingEventId`. Cache result.
    *   *Not Found:* Return `null` values. Cache "empty" result.

### Flow B: Binding (Write)
1.  **Incoming:** `POST /v1/bind` with Body + Proof.
2.  **Validate:** check constraints (EVM format, Hedera ID format).
3.  **Verify Proof:**
    *   `otp_attestation`: Compare with `BINDING_SHARED_SECRET`.
    *   `sig`: Ecrecover signature of "Bind <EVM> to <Hedera> on <WorldId>".
    *   `magic_jwt`: **Placeholder** (checks length > 20).
4.  **Construct:** Create `BindingEvent` object.
5.  **Submit:** Send to HCS via `TopicMessageSubmitTransaction`.
6.  **Return:** Success with `bindingEventId` (Sequence Number).

---

## 6. Trust, Security & Safety Invariants

### Threat Assumptions
*   **Public Read:** The HCS Topic is public; anyone can read the raw binding data.
*   **Restricted Write:** Only the service (holding `HEDERA_OPERATOR_KEY`) can write to the topic.
*   **Mirror Node Reliability:** The service assumes the configured Mirror Node is truthful and available.

### Safety Rails
*   **Fail-Soft Resolution:** If the Mirror Node is down or returns garbage, `resolve` returns a valid JSON with `null` fields, preventing client crashes.
*   **Strict Types:** Zod enforces strict regex on EVM addresses (`^0x[a-fA-F0-9]{40}$`) and Hedera IDs (`^0\.0\.\d+$`).

---

## 7. Explicit Non-Goals & Anti-Patterns

*   **NO Persistent Local State:** The service must not depend on a SQL/NoSQL database. If the container restarts, the cache detects a miss and fetches from HCS.
*   **NO Complex Querying:** It does not support "List all bindings for World ID X". It is strictly a Key-Value lookup (EVM -> Hedera).
*   **NO Private Data:** No PII should ever be written to the HCS topic.

---

## 8. Known Gaps & Open Questions

*   **CRITICAL: History Limit:** `resolveService.ts` hardcodes a limit of `100` messages when fetching from the Mirror Node (`fetchMirrorMessages`).
    *   *Impact:* **Bindings older than the last 100 messages on the topic will conceptually "disappear" from resolution.**
    *   *Status:* Known limitation of v0 "scan" approach. Requires an indexer for production.
*   **Proof Weakness:** `magic_jwt` proof verification is currently a stub (checks string length). It does **not** cryptographically verify the JWT.
*   **Concurrency:** No locking on HCS submission. High volume concurrent writes could theoretically race, though HCS ordering resolves the "truth" (last write wins in current scan logic).

---

## 9. Evolution Rules

*   **Changes:**
    *   Adding new `proofType` handlers is allowed.
    *   Changing the `BindingEvent` schema is **breaking** (old parsers may fail).
*   **Redesign Triggers:**
    *   If the topic exceeds 100 active bindings, the "Scan 100" logic MUST be replaced with a proper Indexer or caching layer that paginates.
