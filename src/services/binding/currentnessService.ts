import { config, RESOLVE_MAX_PAGES_HARD_MAX } from '../../config';
import { fetchMirrorTopicMessagesJson } from '../hedera/client';
import { computeAddress, verifyMessage } from 'ethers';
import type {
    BindingReference,
    CurrentnessIdentity,
    CurrentnessReason,
    CurrentnessRequest,
    CurrentnessResponse,
    EvidenceProvenanceV1,
    BindingEvidenceEnvelopeV1,
    IdentityLifecycleEventV1
} from './types';

const SERVICE_VERSION = '1.0.0';
export const CURRENTNESS_MAX_TOTAL_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CURRENTNESS_MAX_TOTAL_MESSAGES = 5000;

type MirrorMessage = {
    consensus_timestamp: string;
    topic_id: string;
    sequence_number: number;
    payer_account_id?: string;
    message: string;
};

type MirrorMessagePage = {
    messages?: MirrorMessage[];
    links?: { next?: string };
};

const readPageMessages = (page: MirrorMessagePage): MirrorMessage[] => {
    if (!page || typeof page !== 'object' || (page.messages !== undefined && !Array.isArray(page.messages))) {
        throw new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror returned an invalid currentness page.');
    }
    const messages = page.messages ?? [];
    if (messages.some(message =>
        !message ||
        typeof message !== 'object' ||
        !Number.isSafeInteger(message.sequence_number) ||
        message.sequence_number < 1 ||
        typeof message.consensus_timestamp !== 'string' ||
        typeof message.topic_id !== 'string' ||
        typeof message.message !== 'string' ||
        (message.payer_account_id !== undefined && typeof message.payer_account_id !== 'string')
    )) {
        throw new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror returned an invalid currentness page.');
    }
    const links = (page as MirrorMessagePage & { links?: unknown }).links;
    if (
        links !== undefined &&
        (!links || typeof links !== 'object' || Array.isArray(links) ||
            ((links as { next?: unknown }).next !== undefined && typeof (links as { next?: unknown }).next !== 'string'))
    ) {
        throw new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror returned an invalid currentness page.');
    }
    return messages;
};

const uniqueSequenceStream = (
    messages: MirrorMessage[],
    watermark: number
): { messages: MirrorMessage[]; valid: boolean } => {
    const bySequence = new Map<number, MirrorMessage>();
    let valid = true;

    for (const message of messages) {
        if (!Number.isSafeInteger(message.sequence_number)) {
            valid = false;
            continue;
        }
        if (message.sequence_number > watermark) continue;
        if (message.sequence_number < 1) {
            valid = false;
            continue;
        }

        const existing = bySequence.get(message.sequence_number);
        if (existing) {
            if (stableJson(existing) !== stableJson(message)) {
                throw new CurrentnessReadError(
                    'UPSTREAM_PERMANENT_FAILURE',
                    'Mirror returned conflicting content for a topic sequence.'
                );
            }
            continue;
        }
        bySequence.set(message.sequence_number, message);
    }

    return {
        messages: [...bySequence.values()].sort((a, b) => a.sequence_number - b.sequence_number),
        valid
    };
};

type BindingRecord = {
    accountId: string;
    evmPublicAddress: string;
    ref: BindingReference;
    sourceEventAt: string;
    effectiveAt: string;
    sequenceNumber: number;
    provenance: EvidenceProvenanceV1;
};

type LifecycleRecord = {
    event: IdentityLifecycleEventV1;
    effectiveAt: string;
    sequenceNumber: number;
};

export class CurrentnessReadError extends Error {
    constructor(
        public readonly code:
            | 'CAPABILITY_ABSENT'
            | 'UPSTREAM_AUTHENTICATION_FAILURE'
            | 'UPSTREAM_CAPABILITY_ABSENT'
            | 'UPSTREAM_PERMANENT_FAILURE'
            | 'TIMEOUT'
            | 'TEMPORARY_OUTAGE',
        message: string
    ) {
        super(message);
        this.name = 'CurrentnessReadError';
    }
}

const accountKey = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';

const sameIdentity = (a: CurrentnessIdentity, b: CurrentnessIdentity): boolean =>
    a.canonicalDid === b.canonicalDid &&
    a.stableIdentifier === b.stableIdentifier &&
    a.issuer === b.issuer;

const touchesIdentity = (candidate: Partial<CurrentnessIdentity> | undefined, identity: CurrentnessIdentity): boolean =>
    !!candidate && [
        candidate.canonicalDid === identity.canonicalDid,
        candidate.stableIdentifier === identity.stableIdentifier,
        candidate.issuer === identity.issuer
    ].filter(Boolean).length > 0;

const isIsoTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));

const decode = (message: string): unknown => {
    try {
        return JSON.parse(Buffer.from(message, 'base64').toString('utf8'));
    } catch {
        return null;
    }
};

const stableJson = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
};

export const canonicalEvidencePayload = (value: unknown): string => {
    if (!value || typeof value !== 'object') {
        throw new Error('Signed evidence must be an object.');
    }
    const event = value as Record<string, unknown>;
    const provenance = event.provenance;
    if (!provenance || typeof provenance !== 'object') {
        throw new Error('Signed evidence provenance is missing.');
    }
    const { signature: _signature, ...unsignedProvenance } = provenance as Record<string, unknown>;
    return stableJson({ ...event, provenance: unsignedProvenance });
};

const consensusIso = (timestamp: string): string => {
    const [seconds, nanos = '0'] = timestamp.split('.');
    const milliseconds = Number(seconds) * 1000 + Math.floor(Number(`0.${nanos}`) * 1000);
    return new Date(milliseconds).toISOString();
};

const bindingRef = (
    identity: CurrentnessIdentity,
    message: MirrorMessage
): BindingReference => ({
    ...identity,
    network: config.HEDERA_NETWORK,
    topicId: config.IDENTITY_TOPIC_ID,
    bindingEventId: `${message.topic_id}:${message.sequence_number}`,
    schemaVersion: 1,
    normalizationVersion: 'exact-v1'
});

const isBindingEnvelope = (value: unknown): value is BindingEvidenceEnvelopeV1 => {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<BindingEvidenceEnvelopeV1>;
    return (event.t === 'IDENTITY_BIND' || event.t === 'IDENTITY_ASSERT') &&
        event.v === 1 &&
        typeof event.sub === 'string' && event.sub.length > 0 &&
        isIsoTimestamp(event.iat) &&
        (event.chain === 'testnet' || event.chain === 'mainnet' || event.chain === 'previewnet') &&
        !!event.payload &&
        typeof event.payload.stable_identifier === 'string' && event.payload.stable_identifier.length > 0 &&
        typeof event.payload.issuer === 'string' && event.payload.issuer.length > 0 &&
        typeof event.payload.evm_address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(event.payload.evm_address) &&
        typeof event.payload.hedera_account_id === 'string' &&
        /^0\.0\.\d+$/.test(event.payload.hedera_account_id);
};

const isBindingReference = (value: unknown): value is BindingReference => {
    if (!value || typeof value !== 'object') return false;
    const ref = value as Partial<BindingReference>;
    return (ref.network === 'testnet' || ref.network === 'mainnet' || ref.network === 'previewnet') &&
        typeof ref.topicId === 'string' &&
        typeof ref.bindingEventId === 'string' && ref.bindingEventId.startsWith(`${ref.topicId}:`) &&
        ref.schemaVersion === 1 &&
        ref.normalizationVersion === 'exact-v1' &&
        typeof ref.canonicalDid === 'string' &&
        typeof ref.stableIdentifier === 'string' &&
        typeof ref.issuer === 'string';
};

const isEvidenceProvenance = (value: unknown): value is EvidenceProvenanceV1 => {
    if (!value || typeof value !== 'object') return false;
    const provenance = value as Partial<EvidenceProvenanceV1>;
    return provenance.schemaVersion === 1 &&
        typeof provenance.authorityAccountId === 'string' && provenance.authorityAccountId.length > 0 &&
        typeof provenance.authorityKeyId === 'string' && provenance.authorityKeyId.length > 0 &&
        typeof provenance.authorizationBasis === 'string' && provenance.authorizationBasis.length > 0 &&
        provenance.authorizationBasisVersion === 'v1' &&
        provenance.signatureAlgorithm === 'EIP191_SECP256K1' &&
        !!provenance.scope &&
        typeof provenance.scope.purpose === 'string' &&
        (provenance.scope.network === 'testnet' || provenance.scope.network === 'mainnet' || provenance.scope.network === 'previewnet') &&
        typeof provenance.scope.topicId === 'string' &&
        typeof provenance.scope.schemaVersion === 'number' &&
        typeof provenance.scope.normalizationVersion === 'string' &&
        typeof provenance.signature === 'string' && provenance.signature.length > 0;
};

const isLifecycleEvent = (value: unknown): value is IdentityLifecycleEventV1 => {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<IdentityLifecycleEventV1>;
    const replacementIsValid = event.type === 'IDENTITY_SUPERSEDE'
        ? isBindingReference(event.replacement)
        : event.replacement === undefined;

    return (event.type === 'IDENTITY_REVOKE' || event.type === 'IDENTITY_SUPERSEDE') &&
        event.schemaVersion === 1 &&
        event.normalizationVersion === 'exact-v1' &&
        typeof event.lifecycleEventId === 'string' && event.lifecycleEventId.length > 0 &&
        isBindingReference(event.target) &&
        replacementIsValid &&
        isIsoTimestamp(event.sourceEventAt) &&
        isEvidenceProvenance(event.provenance) &&
        typeof event.evidenceRef === 'string' && event.evidenceRef.length > 0;
};

type AuthorityPolicy = {
    accountId: string | undefined;
    keyId: string | undefined;
    publicKey: string | undefined;
    authorizationBasis: string | undefined;
};

type ProvenanceResult = 'valid' | 'unresolved' | 'unverified' | 'scope_mismatch';

const verifyProvenance = (
    event: { provenance?: EvidenceProvenanceV1 },
    message: MirrorMessage,
    policy: AuthorityPolicy
): ProvenanceResult => {
    if (!message.payer_account_id) return 'unresolved';
    if (!isEvidenceProvenance(event.provenance)) return 'unverified';

    const provenance = event.provenance;
    if (
        message.topic_id !== config.IDENTITY_TOPIC_ID ||
        provenance.scope.network !== config.HEDERA_NETWORK ||
        provenance.scope.topicId !== config.IDENTITY_TOPIC_ID ||
        provenance.scope.purpose !== 'TRUSTMESH_IDENTITY_CURRENTNESS' ||
        provenance.scope.schemaVersion !== 1 ||
        provenance.scope.normalizationVersion !== 'exact-v1'
    ) {
        return 'scope_mismatch';
    }
    if (
        accountKey(message.payer_account_id) !== accountKey(policy.accountId) ||
        accountKey(provenance.authorityAccountId) !== accountKey(policy.accountId) ||
        provenance.authorityKeyId !== policy.keyId ||
        provenance.authorizationBasis !== policy.authorizationBasis ||
        provenance.authorizationBasisVersion !== 'v1'
    ) {
        return 'unverified';
    }

    try {
        const expectedAddress = computeAddress(policy.publicKey!);
        const recoveredAddress = verifyMessage(
            canonicalEvidencePayload(event),
            provenance.signature
        );
        return accountKey(recoveredAddress) === accountKey(expectedAddress) ? 'valid' : 'unverified';
    } catch {
        return 'unverified';
    }
};

const makeResponse = (
    disposition: CurrentnessResponse['disposition'],
    reason: CurrentnessReason,
    identity: CurrentnessIdentity,
    observedAt: string,
    watermark: number,
    watermarkTimestamp: string | null,
    coverageComplete: boolean,
    binding: BindingRecord | null = null,
    replacement: BindingRecord | null = null,
    lifecycle: LifecycleRecord | null = null
): CurrentnessResponse => ({
    responseVersion: 'v1',
    disposition,
    reason,
    identity,
    binding: binding ? {
        hederaAccountId: binding.accountId,
        bindingEventId: binding.ref.bindingEventId,
        evmPublicAddress: binding.evmPublicAddress,
        sourceEventAt: binding.sourceEventAt,
        effectiveAt: binding.effectiveAt,
        authorityAccountId: binding.provenance.authorityAccountId,
        authorityKeyId: binding.provenance.authorityKeyId,
        authorizationBasis: binding.provenance.authorizationBasis,
        authorizationBasisVersion: binding.provenance.authorizationBasisVersion
    } : null,
    replacementBinding: replacement ? {
        hederaAccountId: replacement.accountId,
        bindingEventId: replacement.ref.bindingEventId
    } : null,
    lifecycle: lifecycle ? {
        type: lifecycle.event.type,
        lifecycleEventId: lifecycle.event.lifecycleEventId,
        sourceEventAt: lifecycle.event.sourceEventAt,
        effectiveAt: lifecycle.effectiveAt,
        authorityAccountId: lifecycle.event.provenance.authorityAccountId,
        authorityKeyId: lifecycle.event.provenance.authorityKeyId,
        authorizationBasis: lifecycle.event.provenance.authorizationBasis,
        authorizationBasisVersion: lifecycle.event.provenance.authorizationBasisVersion,
        evidenceRef: lifecycle.event.evidenceRef
    } : null,
    evidenceRef: lifecycle?.event.evidenceRef ?? binding?.ref.bindingEventId ??
        `hcs:${config.HEDERA_NETWORK}:${config.IDENTITY_TOPIC_ID}:watermark:${watermark}`,
    serviceVersion: SERVICE_VERSION,
    observedAt,
    validUntil: disposition === 'UNKNOWN_STALE'
        ? observedAt
        : new Date(new Date(observedAt).getTime() + config.CURRENTNESS_VALIDITY_MS).toISOString(),
    authoritativeWatermark: {
        network: config.HEDERA_NETWORK,
        topicId: config.IDENTITY_TOPIC_ID,
        sequenceNumber: watermark,
        consensusTimestamp: watermarkTimestamp,
        coverageComplete
    }
});

export const reduceCurrentness = (
    request: CurrentnessRequest,
    messages: MirrorMessage[],
    observedAt: string,
    watermark: number,
    coverageComplete: boolean
): CurrentnessResponse => {
    const identity = { ...request.identity };
    const watermarkMessage = messages.find(message => message.sequence_number === watermark);
    const watermarkTimestamp = watermarkMessage ? consensusIso(watermarkMessage.consensus_timestamp) : null;

    if (!coverageComplete) {
        return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_PAGINATION', identity, observedAt, watermark, watermarkTimestamp, false);
    }

    const bindings: BindingRecord[] = [];
    const lifecycle: LifecycleRecord[] = [];
    let unsupportedApplicableEvidence = false;
    let unresolvedWriterAttribution = false;
    let unverifiedWriterProvenance = false;
    let evidenceScopeMismatch = false;
    let conflictingLineage = false;

    const bindingAuthority: AuthorityPolicy = {
        accountId: config.BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID,
        keyId: config.BINDING_EVIDENCE_AUTHORITY_KEY_ID,
        publicKey: config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY,
        authorizationBasis: config.BINDING_EVIDENCE_AUTHORIZATION_BASIS
    };
    const lifecycleAuthority: AuthorityPolicy = {
        accountId: config.LIFECYCLE_AUTHORITY_ACCOUNT_ID,
        keyId: config.LIFECYCLE_AUTHORITY_KEY_ID,
        publicKey: config.LIFECYCLE_AUTHORITY_PUBLIC_KEY,
        authorizationBasis: config.LIFECYCLE_AUTHORIZATION_BASIS
    };

    for (const message of messages) {
        if (message.topic_id !== config.IDENTITY_TOPIC_ID) {
            evidenceScopeMismatch = true;
            continue;
        }
        const raw = decode(message.message);
        if (!raw || typeof raw !== 'object') continue;

        const possibleBinding = raw as Partial<BindingEvidenceEnvelopeV1>;
        if (possibleBinding.t === 'IDENTITY_BIND' || possibleBinding.t === 'IDENTITY_ASSERT') {
            if (!isBindingEnvelope(raw)) {
                const partialPayload = possibleBinding.payload as Partial<BindingEvidenceEnvelopeV1['payload']> | undefined;
                if (touchesIdentity({
                    canonicalDid: possibleBinding.sub,
                    stableIdentifier: partialPayload?.stable_identifier,
                    issuer: partialPayload?.issuer
                }, identity)) {
                    unsupportedApplicableEvidence = true;
                }
                continue;
            }

            const eventIdentity: CurrentnessIdentity = {
                canonicalDid: raw.sub,
                stableIdentifier: raw.payload.stable_identifier,
                issuer: raw.payload.issuer
            };
            if (sameIdentity(eventIdentity, identity) && raw.chain === config.HEDERA_NETWORK) {
                const provenance = verifyProvenance(raw, message, bindingAuthority);
                if (provenance === 'unresolved') {
                    unresolvedWriterAttribution = true;
                    continue;
                }
                if (provenance === 'unverified') {
                    unverifiedWriterProvenance = true;
                    continue;
                }
                if (provenance === 'scope_mismatch') {
                    evidenceScopeMismatch = true;
                    continue;
                }
                bindings.push({
                    accountId: raw.payload.hedera_account_id,
                    evmPublicAddress: raw.payload.evm_address,
                    ref: bindingRef(identity, message),
                    sourceEventAt: raw.iat,
                    effectiveAt: consensusIso(message.consensus_timestamp),
                    sequenceNumber: message.sequence_number,
                    provenance: raw.provenance!
                });
            } else if (touchesIdentity(eventIdentity, identity)) {
                conflictingLineage = true;
            }
            continue;
        }

        const partial = raw as {
            type?: string;
            target?: Partial<BindingReference>;
            authority?: { accountId?: string; authorizationBasis?: string };
        };
        if (!touchesIdentity(partial.target, identity)) continue;
        if (partial.type !== 'IDENTITY_REVOKE' && partial.type !== 'IDENTITY_SUPERSEDE') {
            if (typeof partial.type === 'string' && partial.type.startsWith('IDENTITY_')) {
                unsupportedApplicableEvidence = true;
            }
            continue;
        }
        if (!isLifecycleEvent(raw)) {
            unverifiedWriterProvenance = true;
            continue;
        }

        const provenance = verifyProvenance(raw, message, lifecycleAuthority);
        if (provenance === 'unresolved') {
            unresolvedWriterAttribution = true;
            continue;
        }
        if (provenance === 'unverified') {
            unverifiedWriterProvenance = true;
            continue;
        }
        if (provenance === 'scope_mismatch') {
            evidenceScopeMismatch = true;
            continue;
        }

        if (
            !sameIdentity(raw.target, identity) ||
            raw.target.network !== config.HEDERA_NETWORK ||
            raw.target.topicId !== config.IDENTITY_TOPIC_ID ||
            (raw.replacement && (
                !sameIdentity(raw.replacement, identity) ||
                raw.replacement.network !== config.HEDERA_NETWORK ||
                raw.replacement.topicId !== config.IDENTITY_TOPIC_ID
            ))
        ) {
            conflictingLineage = true;
            continue;
        }

        lifecycle.push({
            event: raw,
            effectiveAt: consensusIso(message.consensus_timestamp),
            sequenceNumber: message.sequence_number
        });
    }

    if (unresolvedWriterAttribution) {
        return makeResponse('UNKNOWN_STALE', 'UNRESOLVED_WRITER_ATTRIBUTION', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (unverifiedWriterProvenance) {
        return makeResponse('UNKNOWN_STALE', 'UNVERIFIED_WRITER_PROVENANCE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (evidenceScopeMismatch) {
        return makeResponse('UNKNOWN_STALE', 'EVIDENCE_SCOPE_MISMATCH', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (conflictingLineage) {
        return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (unsupportedApplicableEvidence) {
        return makeResponse('UNKNOWN_STALE', 'UNSUPPORTED_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    const bindingByRef = new Map(bindings.map(binding => [binding.ref.bindingEventId, binding]));
    const lifecycleById = new Map<string, LifecycleRecord>();
    for (const record of lifecycle.sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
        const existing = lifecycleById.get(record.event.lifecycleEventId);
        if (existing) {
            if (canonicalEvidencePayload(existing.event) !== canonicalEvidencePayload(record.event)) {
                return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
            continue;
        }
        lifecycleById.set(record.event.lifecycleEventId, record);
    }

    type BindingTransition = {
        record: LifecycleRecord;
        target: BindingRecord;
        replacement: BindingRecord | null;
    };
    const transitions = new Map<string, BindingTransition>();
    const replacementBindingIds = new Set<string>();
    for (const record of lifecycleById.values()) {
        const targetId = record.event.target.bindingEventId;
        const target = bindingByRef.get(targetId);
        if (!target || target.sequenceNumber >= record.sequenceNumber) {
            return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
        }

        let replacement: BindingRecord | null = null;
        if (record.event.type === 'IDENTITY_SUPERSEDE') {
            replacement = bindingByRef.get(record.event.replacement!.bindingEventId) ?? null;
            if (!replacement || replacement.sequenceNumber >= record.sequenceNumber) {
                return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
        }

        const existing = transitions.get(targetId);
        if (existing) {
            return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
        }
        transitions.set(targetId, { record, target, replacement });
        if (replacement) replacementBindingIds.add(replacement.ref.bindingEventId);
    }

    if (bindings.length === 0) {
        return makeResponse('UNBOUND', 'NO_BINDING', identity, observedAt, watermark, watermarkTimestamp, true);
    }

    const roots = bindings.filter(binding => !replacementBindingIds.has(binding.ref.bindingEventId));

    // An assertion after a valid revocation does not reactivate that exact binding.
    // Keep the response anchored to the revocation's target, never a later assertion.
    const revocations = [...transitions.values()].filter(
        transition => transition.record.event.type === 'IDENTITY_REVOKE'
    );
    if (revocations.length === 1) {
        const transition = revocations[0];
        const laterAssertions = bindings.filter(
            binding => binding.ref.bindingEventId !== transition.target.ref.bindingEventId
        );
        if (laterAssertions.length > 0 && laterAssertions.every(binding =>
            binding.accountId === transition.target.accountId &&
            binding.sequenceNumber > transition.record.sequenceNumber &&
            !transitions.has(binding.ref.bindingEventId) &&
            !replacementBindingIds.has(binding.ref.bindingEventId)
        )) {
            return makeResponse(
                'REVOKED',
                'VALID_REVOCATION',
                identity,
                observedAt,
                watermark,
                watermarkTimestamp,
                true,
                transition.target,
                null,
                transition.record
            );
        }
    }

    if (roots.length !== 1) {
        return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
    }

    const root = roots[0];
    let active = root;
    let supersession: LifecycleRecord | null = null;
    const visited = new Set<string>();
    while (true) {
        const bindingEventId = active.ref.bindingEventId;
        if (visited.has(bindingEventId)) {
            return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
        }
        visited.add(bindingEventId);
        const transition = transitions.get(bindingEventId);
        if (!transition) break;
        if (transition.record.event.type === 'IDENTITY_REVOKE') {
            const unvisited = bindings.filter(binding => !visited.has(binding.ref.bindingEventId));
            if (unvisited.length > 0 && !unvisited.every(binding =>
                binding.accountId === transition.target.accountId &&
                binding.sequenceNumber > transition.record.sequenceNumber &&
                !transitions.has(binding.ref.bindingEventId) &&
                !replacementBindingIds.has(binding.ref.bindingEventId)
            )) {
                return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
            return makeResponse(
                'REVOKED',
                'VALID_REVOCATION',
                identity,
                observedAt,
                watermark,
                watermarkTimestamp,
                true,
                transition.target,
                null,
                transition.record
            );
        }
        supersession = transition.record;
        active = transition.replacement!;
    }

    if (visited.size !== bindingByRef.size) {
        return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (supersession) {
        return makeResponse(
            'SUPERSEDED',
            'VALID_SUPERSESSION',
            identity,
            observedAt,
            watermark,
            watermarkTimestamp,
            true,
            root,
            active,
            supersession
        );
    }

    return makeResponse('CURRENT', 'ACTIVE_AT_WATERMARK', identity, observedAt, watermark, watermarkTimestamp, true, active);
};

const classifyReadFailure = (error: unknown): CurrentnessReadError => {
    if (error instanceof CurrentnessReadError) return error;
    const policyCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    if (policyCode === 'MIRROR_CONFIG_INVALID') {
        return new CurrentnessReadError('CAPABILITY_ABSENT', 'Configured Mirror URL is invalid.');
    }
    if (policyCode.startsWith('MIRROR_')) {
        return new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror pagination violated the configured read boundary.');
    }
    const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : null;
    if (status === 401 || status === 403) {
        return new CurrentnessReadError('UPSTREAM_AUTHENTICATION_FAILURE', `Mirror authentication failed with ${status}.`);
    }
    if (status === 404) {
        return new CurrentnessReadError('UPSTREAM_CAPABILITY_ABSENT', 'Configured Mirror topic capability was not found.');
    }
    if (status !== null && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
        return new CurrentnessReadError('TEMPORARY_OUTAGE', `Mirror is temporarily unavailable (${status}).`);
    }
    if (status !== null) {
        return new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', `Mirror rejected the read with ${status}.`);
    }
    if (
        (error instanceof Error && error.name === 'AbortError') ||
        ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(policyCode)
    ) {
        return new CurrentnessReadError('TIMEOUT', 'Mirror read timed out.');
    }
    const transportCode = policyCode;
    if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(transportCode)) {
        return new CurrentnessReadError('TEMPORARY_OUTAGE', 'Mirror transport failed.');
    }
    return new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror returned an invalid permanent response.');
};

const MIRROR_MIN_REQUEST_INTERVAL_MS = 1000;

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const createCurrentnessPageReader = (
    fetchOptions: { onResponseBytes: (bytes: number) => void }
): ((path: string) => Promise<MirrorMessagePage>) => {
    let lastRequestStartedAt: number | undefined;

    return async (path: string): Promise<MirrorMessagePage> => {
        const now = Date.now();
        const nextPacedAt = lastRequestStartedAt === undefined
            ? now
            : lastRequestStartedAt + MIRROR_MIN_REQUEST_INTERVAL_MS;
        const pacingWaitMs = Math.max(0, nextPacedAt - now);
        if (pacingWaitMs > 0) await delay(pacingWaitMs);
        lastRequestStartedAt = Date.now();

        return fetchMirrorTopicMessagesJson<MirrorMessagePage>(
            path,
            config.IDENTITY_TOPIC_ID,
            fetchOptions
        );
    };
};

export class CurrentnessService {
    static assertCapability(): void {
        if (
            config.RESOLVE_MAX_PAGES_VALID === false ||
            !Number.isSafeInteger(config.RESOLVE_MAX_PAGES) ||
            config.RESOLVE_MAX_PAGES <= 0 ||
            config.RESOLVE_MAX_PAGES > RESOLVE_MAX_PAGES_HARD_MAX
        ) {
            throw new CurrentnessReadError(
                'CAPABILITY_ABSENT',
                'Currentness pagination limits are not configured safely.'
            );
        }

        if (
            !config.CURRENTNESS_SERVICE_TOKEN ||
            !config.BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID ||
            !config.BINDING_EVIDENCE_AUTHORITY_KEY_ID ||
            !config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY ||
            !config.BINDING_EVIDENCE_AUTHORIZATION_BASIS ||
            !config.LIFECYCLE_AUTHORITY_ACCOUNT_ID ||
            !config.LIFECYCLE_AUTHORITY_KEY_ID ||
            !config.LIFECYCLE_AUTHORITY_PUBLIC_KEY ||
            !config.LIFECYCLE_AUTHORIZATION_BASIS
        ) {
            throw new CurrentnessReadError(
                'CAPABILITY_ABSENT',
                'Currentness authentication or signed evidence authorities are not configured.'
            );
        }

        try {
            computeAddress(config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY);
            computeAddress(config.LIFECYCLE_AUTHORITY_PUBLIC_KEY);
        } catch {
            throw new CurrentnessReadError(
                'CAPABILITY_ABSENT',
                'A configured evidence authority public key is invalid.'
            );
        }
    }

    static async read(request: CurrentnessRequest): Promise<CurrentnessResponse> {
        this.assertCapability();
        const observedAt = new Date().toISOString();

        try {
            let totalResponseBytes = 0;
            const onResponseBytes = (bytes: number): void => {
                if (!Number.isSafeInteger(bytes) || bytes < 0) {
                    throw new CurrentnessReadError(
                        'UPSTREAM_PERMANENT_FAILURE',
                        'Mirror returned an invalid currentness response size.'
                    );
                }
                totalResponseBytes += bytes;
                if (totalResponseBytes > CURRENTNESS_MAX_TOTAL_RESPONSE_BYTES) {
                    throw new CurrentnessReadError(
                        'UPSTREAM_PERMANENT_FAILURE',
                        'Mirror currentness read exceeded the configured evidence limit.'
                    );
                }
            };
            const readPage = createCurrentnessPageReader({ onResponseBytes });
            const initialPage = await readPage(
                `/topics/${config.IDENTITY_TOPIC_ID}/messages?limit=100&order=desc`
            );
            const initialMessages = readPageMessages(initialPage);
            if (initialMessages.some((message, index) =>
                index > 0 && initialMessages[index - 1].sequence_number < message.sequence_number
            )) {
                throw new CurrentnessReadError(
                    'UPSTREAM_PERMANENT_FAILURE',
                    'Mirror returned currentness messages outside descending sequence order.'
                );
            }
            let totalMessages = initialMessages.length;
            if (totalMessages > CURRENTNESS_MAX_TOTAL_MESSAGES) {
                throw new CurrentnessReadError(
                    'UPSTREAM_PERMANENT_FAILURE',
                    'Mirror currentness read exceeded the configured evidence limit.'
                );
            }
            const watermark = initialMessages[0]?.sequence_number ?? 0;
            if (!Number.isSafeInteger(watermark) || watermark < 0) {
                throw new CurrentnessReadError('UPSTREAM_PERMANENT_FAILURE', 'Mirror topic watermark is invalid.');
            }

            const messages: MirrorMessage[] = initialMessages.filter(message => message.sequence_number <= watermark);
            let next = initialPage.links?.next;
            let pages = 1;
            while (next && pages < config.RESOLVE_MAX_PAGES) {
                const page = await readPage(next);
                const pageMessages = readPageMessages(page);
                if (pageMessages.some((message, index) =>
                    index > 0 && pageMessages[index - 1].sequence_number < message.sequence_number
                )) {
                    throw new CurrentnessReadError(
                        'UPSTREAM_PERMANENT_FAILURE',
                        'Mirror returned currentness messages outside descending sequence order.'
                    );
                }
                totalMessages += pageMessages.length;
                if (totalMessages > CURRENTNESS_MAX_TOTAL_MESSAGES) {
                    throw new CurrentnessReadError(
                        'UPSTREAM_PERMANENT_FAILURE',
                        'Mirror currentness read exceeded the configured evidence limit.'
                    );
                }
                messages.push(...pageMessages.filter(message => message.sequence_number <= watermark));
                next = page.links?.next;
                pages++;
            }

            const sequenceStream = uniqueSequenceStream(messages, watermark);
            const seen = new Set(sequenceStream.messages.map(message => message.sequence_number));
            const coverageComplete = sequenceStream.valid && !next && seen.size === watermark &&
                [...seen].every(sequence => Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= watermark);

            return reduceCurrentness(request, sequenceStream.messages, observedAt, watermark, coverageComplete);
        } catch (error) {
            throw classifyReadFailure(error);
        }
    }
}
