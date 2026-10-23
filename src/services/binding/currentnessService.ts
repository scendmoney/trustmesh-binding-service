import { config } from '../../config';
import { fetchMirrorJson } from '../hedera/client';
import type {
    BindingReference,
    CurrentnessIdentity,
    CurrentnessReason,
    CurrentnessRequest,
    CurrentnessResponse,
    FounderBindingEnvelope,
    IdentityLifecycleEventV1
} from './types';

const SERVICE_VERSION = '2.1.0';

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

type BindingRecord = {
    accountId: string;
    ref: BindingReference;
    sourceEventAt: string;
    effectiveAt: string;
    sequenceNumber: number;
};

type LifecycleRecord = {
    event: IdentityLifecycleEventV1;
    effectiveAt: string;
    sequenceNumber: number;
};

export class CurrentnessReadError extends Error {
    constructor(
        public readonly code: 'CAPABILITY_ABSENT' | 'TIMEOUT' | 'TRANSPORT_OUTAGE',
        message: string
    ) {
        super(message);
    }
}

const normalize = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeIdentity = (identity: CurrentnessIdentity): CurrentnessIdentity => ({
    canonicalDid: normalize(identity.canonicalDid),
    stableIdentifier: normalize(identity.stableIdentifier),
    issuer: normalize(identity.issuer)
});

const sameIdentity = (a: CurrentnessIdentity, b: CurrentnessIdentity): boolean =>
    normalize(a.canonicalDid) === normalize(b.canonicalDid) &&
    normalize(a.stableIdentifier) === normalize(b.stableIdentifier) &&
    normalize(a.issuer) === normalize(b.issuer);

const touchesIdentity = (candidate: Partial<CurrentnessIdentity> | undefined, identity: CurrentnessIdentity): boolean =>
    !!candidate && [
        normalize(candidate.canonicalDid) === identity.canonicalDid,
        normalize(candidate.stableIdentifier) === identity.stableIdentifier,
        normalize(candidate.issuer) === identity.issuer
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
    normalizationVersion: 'v1'
});

const isBindingEnvelope = (value: unknown): value is FounderBindingEnvelope => {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<FounderBindingEnvelope>;
    return (event.t === 'IDENTITY_BIND' || event.t === 'IDENTITY_ASSERT') &&
        event.v === 1 &&
        typeof event.sub === 'string' &&
        isIsoTimestamp(event.iat) &&
        (event.chain === 'testnet' || event.chain === 'mainnet' || event.chain === 'previewnet') &&
        !!event.payload &&
        typeof event.payload.stable_identifier === 'string' &&
        typeof event.payload.issuer === 'string' &&
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
        ref.normalizationVersion === 'v1' &&
        typeof ref.canonicalDid === 'string' &&
        typeof ref.stableIdentifier === 'string' &&
        typeof ref.issuer === 'string';
};

const isLifecycleEvent = (value: unknown): value is IdentityLifecycleEventV1 => {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<IdentityLifecycleEventV1>;
    const replacementIsValid = event.type === 'IDENTITY_SUPERSEDE'
        ? isBindingReference(event.replacement)
        : event.replacement === undefined;

    return (event.type === 'IDENTITY_REVOKE' || event.type === 'IDENTITY_SUPERSEDE') &&
        event.schemaVersion === 1 &&
        event.normalizationVersion === 'v1' &&
        typeof event.lifecycleEventId === 'string' && event.lifecycleEventId.length > 0 &&
        isBindingReference(event.target) &&
        replacementIsValid &&
        isIsoTimestamp(event.sourceEventAt) &&
        !!event.authority &&
        typeof event.authority.accountId === 'string' &&
        typeof event.authority.authorizationBasis === 'string' &&
        typeof event.evidenceRef === 'string' && event.evidenceRef.length > 0;
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
        sourceEventAt: binding.sourceEventAt,
        effectiveAt: binding.effectiveAt
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
        authorityAccountId: lifecycle.event.authority.accountId,
        authorizationBasis: lifecycle.event.authority.authorizationBasis,
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
    const identity = normalizeIdentity(request.identity);
    const watermarkMessage = messages.find(message => message.sequence_number === watermark);
    const watermarkTimestamp = watermarkMessage ? consensusIso(watermarkMessage.consensus_timestamp) : null;

    if (!coverageComplete) {
        return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_PAGINATION', identity, observedAt, watermark, watermarkTimestamp, false);
    }

    const bindings: BindingRecord[] = [];
    const lifecycle: LifecycleRecord[] = [];
    let unsupportedApplicableEvidence = false;
    let unresolvedWriterAttribution = false;
    let conflictingLineage = false;

    for (const message of messages) {
        const raw = decode(message.message);
        if (!raw || typeof raw !== 'object') continue;

        const possibleBinding = raw as Partial<FounderBindingEnvelope>;
        if (possibleBinding.t === 'IDENTITY_BIND' || possibleBinding.t === 'IDENTITY_ASSERT') {
            if (!isBindingEnvelope(raw)) {
                const partialPayload = possibleBinding.payload as Partial<FounderBindingEnvelope['payload']> | undefined;
                if (touchesIdentity({
                    canonicalDid: possibleBinding.sub,
                    stableIdentifier: partialPayload?.stable_identifier,
                    issuer: partialPayload?.issuer
                }, identity)) {
                    unsupportedApplicableEvidence = true;
                }
                continue;
            }

            const eventIdentity = normalizeIdentity({
                canonicalDid: raw.sub,
                stableIdentifier: raw.payload.stable_identifier,
                issuer: raw.payload.issuer
            });
            if (sameIdentity(eventIdentity, identity) && raw.chain === config.HEDERA_NETWORK) {
                bindings.push({
                    accountId: raw.payload.hedera_account_id,
                    ref: bindingRef(identity, message),
                    sourceEventAt: raw.iat,
                    effectiveAt: consensusIso(message.consensus_timestamp),
                    sequenceNumber: message.sequence_number
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
        if (partial.type !== 'IDENTITY_REVOKE' && partial.type !== 'IDENTITY_SUPERSEDE') continue;
        if (!touchesIdentity(partial.target, identity)) continue;
        if (!isLifecycleEvent(raw)) {
            unsupportedApplicableEvidence = true;
            continue;
        }

        const payer = normalize(message.payer_account_id);
        const configuredAuthority = normalize(config.LIFECYCLE_AUTHORITY_ACCOUNT_ID);
        const eventAuthority = normalize(raw.authority.accountId);
        if (!payer) {
            unresolvedWriterAttribution = true;
            continue;
        }
        if (
            payer !== configuredAuthority ||
            eventAuthority !== configuredAuthority ||
            raw.authority.authorizationBasis !== config.LIFECYCLE_AUTHORIZATION_BASIS
        ) {
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
    if (conflictingLineage) {
        return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (unsupportedApplicableEvidence) {
        return makeResponse('UNKNOWN_STALE', 'UNSUPPORTED_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
    }
    if (bindings.length === 0) {
        return makeResponse('UNBOUND', 'NO_BINDING', identity, observedAt, watermark, watermarkTimestamp, true);
    }

    const bindingByRef = new Map(bindings.map(binding => [binding.ref.bindingEventId, binding]));
    const lifecycleById = new Map<string, LifecycleRecord>();
    for (const record of lifecycle.sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
        const existing = lifecycleById.get(record.event.lifecycleEventId);
        if (existing) {
            if (JSON.stringify(existing.event) !== JSON.stringify(record.event)) {
                return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
            continue;
        }
        lifecycleById.set(record.event.lifecycleEventId, record);
    }

    type AccountTransition = { record: LifecycleRecord; replacementAccountId?: string };
    const transitions = new Map<string, AccountTransition>();
    for (const record of lifecycleById.values()) {
        const target = bindingByRef.get(record.event.target.bindingEventId);
        if (!target || target.sequenceNumber >= record.sequenceNumber) {
            return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
        }

        let replacementAccountId: string | undefined;
        if (record.event.type === 'IDENTITY_SUPERSEDE') {
            const replacement = bindingByRef.get(record.event.replacement!.bindingEventId);
            if (!replacement || replacement.sequenceNumber >= record.sequenceNumber) {
                return makeResponse('UNKNOWN_STALE', 'INCOMPLETE_EVIDENCE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
            replacementAccountId = replacement.accountId;
            if (replacementAccountId === target.accountId) {
                return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
            }
        }

        const existing = transitions.get(target.accountId);
        if (existing) {
            return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
        }
        transitions.set(target.accountId, { record, replacementAccountId });
    }

    const bindingsByAccount = new Map<string, BindingRecord[]>();
    for (const binding of bindings) {
        const records = bindingsByAccount.get(binding.accountId) ?? [];
        records.push(binding);
        bindingsByAccount.set(binding.accountId, records);
    }
    const representatives = new Map(
        [...bindingsByAccount.entries()].map(([accountId, records]) => [
            accountId,
            records.sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0]
        ])
    );

    const replacementAccounts = new Set(
        [...transitions.values()].map(value => value.replacementAccountId).filter((value): value is string => !!value)
    );
    const roots = [...bindingsByAccount.keys()].filter(accountId => !replacementAccounts.has(accountId));
    if (roots.length !== 1) {
        return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
    }

    const root = representatives.get(roots[0])!;
    let accountId = roots[0];
    let supersession: LifecycleRecord | null = null;
    const visited = new Set<string>();
    while (true) {
        if (visited.has(accountId)) {
            return makeResponse('AMBIGUOUS', 'CONFLICTING_LINEAGE', identity, observedAt, watermark, watermarkTimestamp, true);
        }
        visited.add(accountId);
        const transition = transitions.get(accountId);
        if (!transition) break;
        if (transition.record.event.type === 'IDENTITY_REVOKE') {
            return makeResponse(
                'REVOKED',
                'VALID_REVOCATION',
                identity,
                observedAt,
                watermark,
                watermarkTimestamp,
                true,
                representatives.get(accountId)!,
                null,
                transition.record
            );
        }
        supersession = transition.record;
        accountId = transition.replacementAccountId!;
    }

    const active = representatives.get(accountId);
    if (!active || visited.size !== bindingsByAccount.size) {
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
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/i.test(error.message))) {
        return new CurrentnessReadError('TIMEOUT', 'Mirror read timed out.');
    }
    return new CurrentnessReadError('TRANSPORT_OUTAGE', 'Mirror read failed.');
};

export class CurrentnessService {
    static assertCapability(): void {
        if (
            !config.CURRENTNESS_SERVICE_TOKEN ||
            !config.LIFECYCLE_AUTHORITY_ACCOUNT_ID ||
            !config.LIFECYCLE_AUTHORIZATION_BASIS
        ) {
            throw new CurrentnessReadError(
                'CAPABILITY_ABSENT',
                'Currentness authentication or lifecycle authority is not configured.'
            );
        }
    }

    static async read(request: CurrentnessRequest): Promise<CurrentnessResponse> {
        this.assertCapability();
        const observedAt = new Date().toISOString();

        try {
            const watermarkPage = await fetchMirrorJson<MirrorMessagePage>(
                `/topics/${config.IDENTITY_TOPIC_ID}/messages?limit=1&order=desc`
            );
            const watermark = Number(watermarkPage.messages?.[0]?.sequence_number ?? 0);
            if (!Number.isSafeInteger(watermark) || watermark < 0) {
                throw new CurrentnessReadError('TRANSPORT_OUTAGE', 'Mirror topic watermark is unavailable.');
            }

            const messages: MirrorMessage[] = [];
            let next: string | undefined = `/topics/${config.IDENTITY_TOPIC_ID}/messages?limit=100&order=desc`;
            let pages = 0;
            while (next && pages < config.RESOLVE_MAX_PAGES) {
                const page: MirrorMessagePage = await fetchMirrorJson<MirrorMessagePage>(next);
                messages.push(...(page.messages ?? []).filter(
                    (message: MirrorMessage) => message.sequence_number <= watermark
                ));
                next = page.links?.next;
                pages++;
            }

            const seen = new Set(messages.map(message => message.sequence_number));
            const coverageComplete = !next && seen.size === watermark &&
                [...seen].every(sequence => Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= watermark);

            return reduceCurrentness(request, messages, observedAt, watermark, coverageComplete);
        } catch (error) {
            throw classifyReadFailure(error);
        }
    }
}
