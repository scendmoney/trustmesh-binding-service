import { config } from '../../config';
import { log } from '../../util/log';
import { lookupAccountByEvm, provisionAccountForEvmAlias, submitToTopic } from '../hedera/client';
import type {
    FounderBindingEnvelope,
    FounderBindingFailureResponse,
    FounderBindingRequest,
    FounderBindingResponse,
    FounderBindingSuccessResponse
} from './types';

const SERVICE_VERSION = '2.0.0';
const CACHE_TTL_MS = 5 * 60 * 1000;

type CachedBinding = FounderBindingSuccessResponse['binding'];

type CacheEntry = {
    binding: CachedBinding;
    timestamp: number;
};

type TopicMatch = {
    hederaAccountId: string;
    bindingEventId: string;
    boundAt: string;
};

const bindingCache = new Map<string, CacheEntry>();

const normalize = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const unbound = (
    reason: FounderBindingFailureResponse['reason'],
    message: string
): FounderBindingFailureResponse => ({
    status: 'unbound',
    reason,
    message
});

const asBound = (binding: CachedBinding): FounderBindingSuccessResponse => ({
    status: 'bound',
    binding
});

const getCachedBinding = (canonicalDid: string): CachedBinding | null => {
    const cached = bindingCache.get(canonicalDid);

    if (!cached) {
        return null;
    }

    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
        bindingCache.delete(canonicalDid);
        return null;
    }

    return cached.binding;
};

const rememberBinding = (binding: CachedBinding): CachedBinding => {
    bindingCache.set(binding.canonicalDid, {
        binding,
        timestamp: Date.now()
    });

    return binding;
};

const createEnvelope = (
    type: FounderBindingEnvelope['t'],
    input: FounderBindingRequest,
    hederaAccountId: string,
    resolutionSource: 'resolved' | 'provisioned',
    options: { createTxId?: string; reason?: string } = {}
): FounderBindingEnvelope => ({
    t: type,
    v: 1,
    sub: normalize(input.founder.canonicalDid),
    iat: new Date().toISOString(),
    chain: config.HEDERA_NETWORK,
    payload: {
        stable_identifier: normalize(input.founder.stableIdentifier),
        issuer: normalize(input.founder.issuer),
        evm_address: normalize(input.founder.evmPublicAddress ?? ''),
        hedera_account_id: hederaAccountId,
        claim_id: input.claimIntent.claimId,
        organism_id: input.claimIntent.organismId,
        source_assessment_id: input.claimIntent.sourceAssessmentId,
        source_intake_id: input.claimIntent.sourceIntakeId,
        source_report_id: input.claimIntent.sourceReportId,
        source_compiler_run_id: input.claimIntent.sourceCompilerRunId,
        requested_role: input.claimIntent.requestedRole,
        resolution_source: resolutionSource,
        create_tx_id: options.createTxId ?? null,
        reason: options.reason ?? null
    }
});

const decodeEnvelope = (message: string): FounderBindingEnvelope | null => {
    try {
        const payload = JSON.parse(
            Buffer.from(message, 'base64').toString('utf8')
        ) as Partial<FounderBindingEnvelope>;

        if (
            (payload.t !== 'IDENTITY_BIND' && payload.t !== 'IDENTITY_ASSERT') ||
            !payload.sub ||
            !payload.payload?.hedera_account_id
        ) {
            return null;
        }

        return payload as FounderBindingEnvelope;
    } catch {
        return null;
    }
};

const matchesFounder = (
    event: FounderBindingEnvelope,
    input: FounderBindingRequest
): boolean => {
    const canonicalDid = normalize(input.founder.canonicalDid);
    const stableIdentifier = normalize(input.founder.stableIdentifier);
    const issuer = normalize(input.founder.issuer);
    const evm = normalize(input.founder.evmPublicAddress ?? '');
    const founderKeys = [canonicalDid, stableIdentifier, issuer, evm].filter(
        candidate => candidate.length > 0
    );

    return [
        normalize(event.sub),
        normalize(event.payload.stable_identifier),
        normalize(event.payload.issuer),
        normalize(event.payload.evm_address)
    ].some(candidate => candidate.length > 0 && founderKeys.includes(candidate));
};

const fetchTopicPage = async (
    nextLink?: string
): Promise<{ messages: any[]; next?: string }> => {
    const baseUrl = config.MIRROR_NODE_URL.endsWith('/')
        ? config.MIRROR_NODE_URL
        : `${config.MIRROR_NODE_URL}/`;

    const url = nextLink
        ? new URL(nextLink, baseUrl).toString()
        : `${config.MIRROR_NODE_URL}/topics/${config.IDENTITY_TOPIC_ID}/messages?limit=100&order=desc`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MIRROR_NODE_TIMEOUT_MS);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Mirror node returned ${response.status}`);
        }

        const payload = (await response.json()) as {
            messages?: any[];
            links?: { next?: string };
        };

        return {
            messages: payload.messages ?? [],
            next: payload.links?.next
        };
    } finally {
        clearTimeout(timeout);
    }
};

const findTopicBinding = async (
    input: FounderBindingRequest
): Promise<TopicMatch | null> => {
    let nextLink: string | undefined;

    for (let page = 0; page < config.RESOLVE_MAX_PAGES; page++) {
        const { messages, next } = await fetchTopicPage(nextLink);

        for (const message of messages) {
            const event = decodeEnvelope(message.message);
            if (!event || !matchesFounder(event, input)) {
                continue;
            }

            return {
                hederaAccountId: event.payload.hedera_account_id,
                bindingEventId: `${message.topic_id}:${message.sequence_number}`,
                boundAt: event.iat
            };
        }

        if (!next) {
            return null;
        }

        nextLink = next;
    }

    return null;
};

const publishDurableEvent = async (
    event: FounderBindingEnvelope
): Promise<{ bindingEventId: string; boundAt: string }> => {
    const result = await submitToTopic(config.IDENTITY_TOPIC_ID, JSON.stringify(event));
    const sequenceNumber = result.sequenceNumber ?? result.topicSequenceNumber;

    if (!sequenceNumber) {
        throw new Error('Binding event was submitted without a topic sequence number.');
    }

    return {
        bindingEventId: `${config.IDENTITY_TOPIC_ID}:${sequenceNumber}`,
        boundAt: event.iat
    };
};

const toBinding = (
    input: FounderBindingRequest,
    hederaAccountId: string,
    bindingEventId: string,
    resolutionSource: 'resolved' | 'provisioned',
    boundAt: string
): CachedBinding => ({
    bindingVersion: 'v0.1',
    canonicalDid: normalize(input.founder.canonicalDid),
    stableIdentifier: normalize(input.founder.stableIdentifier),
    hederaAccountId,
    bindingEventId,
    resolutionSource,
    serviceVersion: SERVICE_VERSION,
    boundAt,
    isDurable: true
});

export class FounderBindingService {
    static async resolveOrProvision(
        input: FounderBindingRequest
    ): Promise<FounderBindingResponse> {
        const canonicalDid = normalize(input.founder.canonicalDid);
        const cached = getCachedBinding(canonicalDid);
        if (cached) {
            return asBound(cached);
        }

        const evmPublicAddress = input.founder.evmPublicAddress
            ? normalize(input.founder.evmPublicAddress)
            : null;

        if (!evmPublicAddress) {
            return unbound(
                'conflict',
                'Founder binding requires an EVM public address from the authenticated Magic identity.'
            );
        }

        try {
            const topicBinding = await findTopicBinding(input);
            if (topicBinding) {
                return asBound(
                    rememberBinding(
                        toBinding(
                            input,
                            topicBinding.hederaAccountId,
                            topicBinding.bindingEventId,
                            'resolved',
                            topicBinding.boundAt
                        )
                    )
                );
            }

            const resolvedAccountId = await lookupAccountByEvm(evmPublicAddress);
            if (resolvedAccountId) {
                const assertEvent = createEnvelope(
                    'IDENTITY_ASSERT',
                    input,
                    resolvedAccountId,
                    'resolved',
                    { reason: 'mirror-resolution' }
                );

                try {
                    const published = await publishDurableEvent(assertEvent);
                    return asBound(
                        rememberBinding(
                            toBinding(
                                input,
                                resolvedAccountId,
                                published.bindingEventId,
                                'resolved',
                                published.boundAt
                            )
                        )
                    );
                } catch (error) {
                    return unbound(
                        'notDurable',
                        error instanceof Error
                            ? `Resolved Hedera account ${resolvedAccountId}, but failed to record a durable binding receipt: ${error.message}`
                            : `Resolved Hedera account ${resolvedAccountId}, but failed to record a durable binding receipt.`
                    );
                }
            }

            const provisioned = await provisionAccountForEvmAlias(evmPublicAddress);
            const bindEvent = createEnvelope(
                'IDENTITY_BIND',
                input,
                provisioned.hederaAccountId,
                'provisioned',
                { createTxId: provisioned.transactionId }
            );

            try {
                const published = await publishDurableEvent(bindEvent);
                return asBound(
                    rememberBinding(
                        toBinding(
                            input,
                            provisioned.hederaAccountId,
                            published.bindingEventId,
                            'provisioned',
                            published.boundAt
                        )
                    )
                );
            } catch (error) {
                return unbound(
                    'notDurable',
                    error instanceof Error
                        ? `Provisioned Hedera account ${provisioned.hederaAccountId}, but failed to record the durable bind event: ${error.message}`
                        : `Provisioned Hedera account ${provisioned.hederaAccountId}, but failed to record the durable bind event.`
                );
            }
        } catch (error) {
            log.error('Founder binding resolve-or-provision failed', error, {
                canonicalDid,
                evmPublicAddress,
                claimId: input.claimIntent.claimId
            });

            return unbound(
                'serviceUnavailable',
                error instanceof Error
                    ? `Founder binding service failed: ${error.message}`
                    : 'Founder binding service failed.'
            );
        }
    }
}

