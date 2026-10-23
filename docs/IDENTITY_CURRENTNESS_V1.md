# TrustMesh Identity Currentness v1

Status: Strategy-ratified local implementation contract
Contract version: `v1`
Normalization version: `exact-v1`
Production authority designation: **UNRESOLVED**

This record makes the Strategy ruling supplied for the T1 currentness work
traceable to the producer-owned schema, reducer, authenticated reader, and
tests. It does not designate a production authority, activate a writer,
provision an identity, publish an event, or prove production coverage.

## Identity and target

Currentness is requested with the exact `canonicalDid`, `stableIdentifier`, and
`issuer`. Version `exact-v1` applies no case folding, trimming, URI rewriting,
or other normalization to those fields.

A lifecycle target identifies all of:

- Hedera network and authoritative topic;
- immutable prior `bindingEventId` (`topicId:sequenceNumber`);
- exact canonical DID, stable identifier, and issuer lineage;
- schema and normalization version.

`IDENTITY_SUPERSEDE` also identifies an exact replacement binding with the same
fields. The replacement must independently exist and be valid before the
supersession event reaches consensus.

## Authorized evidence provenance

Originating `IDENTITY_BIND`/`IDENTITY_ASSERT` evidence and every lifecycle event
must carry `EvidenceProvenanceV1`. The signed canonical payload includes:

- authority account and key identifiers;
- recorded authorization basis and `authorizationBasisVersion: "v1"`;
- `signatureAlgorithm: "EIP191_SECP256K1"`;
- scope purpose `TRUSTMESH_IDENTITY_CURRENTNESS`;
- exact network and topic;
- evidence schema version `1`;
- normalization version `exact-v1`.

Canonical JSON recursively sorts object keys and omits only the signature field
itself. A reader accepts evidence only when the signature verifies against the
separately configured authority public key and the signed account, key ID,
authorization basis/version, purpose, network, topic, schema, and normalization
values all match policy. The observed Mirror `payer_account_id` and `topic_id`
must also match. A payer, configured account ID, or self-asserted payload alone
is not authenticated provenance. Unsigned legacy evidence cannot yield
`CURRENT`.

Binding evidence and lifecycle evidence have separately configured authority
policies. The existing Hedera payer/publisher is not automatically either
authority. Local tests use synthetic keys. No production key or writer is
designated here.

## Ordering and time

One configured authoritative topic is read. Its consensus sequence is the only
total order. No precedence is inferred across independent topics or feeds.

Source event time, effective time, and observation time remain separate. In v1,
a lifecycle transition takes effect at its HCS consensus timestamp. Payload
timestamps cannot backdate or schedule an effect.

## Reduction law

- A valid revocation disqualifies its target. A later ordinary assertion cannot
  reactivate it.
- Supersession atomically retires the exact prior binding in favor of the exact,
  independently valid replacement.
- A missing replacement or missing prior target is incomplete evidence.
- Competing, contradictory, cyclic, or disconnected transitions are conflict.
- Exact replay of the same lifecycle event ID and payload is idempotent.
- Reuse of a lifecycle event ID with different content is conflict.
- All history is preserved during reduction; the first matching bind is never
  treated as sufficient currentness.
- Applicable unknown lifecycle event types, unsupported evidence, unresolved or
  unverifiable provenance, and signed scope mismatch fail closed and cannot
  yield `CURRENT`.

The dispositions are `CURRENT`, `REVOKED`, `SUPERSEDED`, `UNBOUND`,
`AMBIGUOUS`, and `UNKNOWN_STALE`. `AMBIGUOUS` maps to HTTP conflict (`409`).

## Coverage and Mirror boundary

`CURRENT` requires complete topic history through a declared authoritative
watermark. Exhausted pagination limits, sequence gaps, or incomplete applicable
lifecycle coverage produce `UNKNOWN_STALE`.

Every initial and continuation request is constrained before transport to the
configured Mirror origin, configured API base path, exact configured topic, and
the topic `messages` endpoint. Credentials are never attached to a cross-origin,
cross-topic, or different-path continuation URL.

Mirror failures preserve policy-relevant classes: authentication failures,
missing capability/configuration, permanent response failures, explicit
temporary unavailability, recognized transport failures, and timeouts. Only
recognized transient network/timeout codes and explicit temporary HTTP statuses
are outage/fallback eligible.

## API and implementation

The nonmutating API is `POST /v1/currentness`, authenticated with
`x-trustmesh-currentness-token`. It performs Mirror reads only and does not use
the resolve cache, submit events, provision accounts, mutate durable state, or
activate an authority.

The executable schema is in
[`src/services/binding/types.ts`](../src/services/binding/types.ts), and the
reducer/reader is in
[`src/services/binding/currentnessService.ts`](../src/services/binding/currentnessService.ts).
