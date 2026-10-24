import { config } from '../../config';
import { CurrentnessService, canonicalEvidencePayload } from './currentnessService';
import {
    IdentityRegistrationCompletedOutcomeCache,
    IdentityRegistrationService
} from './identityRegistrationService';
import { createApp } from '../../app';
import { log } from '../../util/log';
import {
    fetchMirrorTopicMessagesJson,
    getHederaOperatorEvidenceSigner,
    provisionAccountForEvmAlias,
    reconcileEvmAlias,
    submitToTopic
} from '../hedera/client';
import { TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import { computeAddress, hashMessage, SigningKey, verifyMessage } from 'ethers';
import type {
    IdentityRegistrationBindingEnvelopeV1,
    IdentityRegistrationBlockedReasonV1
} from './types';

const BINDING_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${'33'.repeat(32)}`;
const bindingSigningKey = new SigningKey(BINDING_PRIVATE_KEY);

jest.mock('../../config', () => ({
    RESOLVE_MAX_PAGES_HARD_MAX: 50,
    config: {
        NODE_ENV: 'test',
        HEDERA_NETWORK: 'testnet',
        HEDERA_OPERATOR_ID: '0.0.600',
        HEDERA_OPERATOR_KEY: `0x${'11'.repeat(32)}`,
        IDENTITY_TOPIC_ID: '0.0.999',
        RESOLVE_MAX_PAGES: 5,
        RESOLVE_MAX_PAGES_VALID: true,
        CURRENTNESS_VALIDITY_MS: 30000,
        CURRENTNESS_SERVICE_TOKEN: 'reader-secret',
        BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID: '0.0.600',
        BINDING_EVIDENCE_AUTHORITY_KEY_ID: 'binding-key-v1',
        BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY: '0x044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1',
        BINDING_EVIDENCE_AUTHORIZATION_BASIS: 'strategy-ruling-eugene-t1',
        LIFECYCLE_AUTHORITY_ACCOUNT_ID: '0.0.700',
        LIFECYCLE_AUTHORITY_KEY_ID: 'lifecycle-key-v1',
        LIFECYCLE_AUTHORITY_PUBLIC_KEY: '0x04466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276728176c3c6431f8eeda4538dc37c865e2784f3a9e77d044f33e407797e1278a',
        LIFECYCLE_AUTHORIZATION_BASIS: 'strategy-ruling-eugene-t1',
        WORLDS_BUILDER_SERVICE_TOKEN: 'worlds-builder-secret',
        CORS_ORIGINS: '*',
        MIRROR_NODE_TIMEOUT_MS: 100,
        MIRROR_NODE_AUTH_TYPE: 'none',
        MIRROR_NODE_URL: 'http://127.0.0.1:1234/api/v1',
        MIRROR_NODE_AUTH_TOKEN: undefined
    }
}));

jest.mock('../../util/log', () => ({ log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

jest.mock('../hedera/client', () => ({
    fetchMirrorTopicMessagesJson: jest.fn(),
    getHederaOperatorEvidenceSigner: jest.fn(),
    provisionAccountForEvmAlias: jest.fn(),
    reconcileEvmAlias: jest.fn(),
    submitToTopic: jest.fn()
}));

const identity = {
    canonicalDid: 'did:magic:issuer:user-1',
    stableIdentifier: 'issuer:user-1',
    issuer: 'https://issuer.example'
};

const request = {
    requestVersion: 'v1' as const,
    ...identity,
    evmPublicAddress: '0x1111111111111111111111111111111111111111',
    purpose: 'eugene.business.admin.custody' as const,
    consentReceiptRef: 'cw-consent:receipt-01',
    idempotencyKey: 'registration-01',
    requestedAt: '2026-10-24T18:00:00.000Z'
};

const operationOwnerRef = 'worldsbuilder-0034:claim-operation-01';
const register = (
    input: typeof request = request,
    ownerRef = operationOwnerRef
) => IdentityRegistrationService.register(input, { operationOwnerRef: ownerRef });

const sensitiveSentinels = [
    'did:magic:sentinel:canonical-subject',
    '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'consent:sentinel:receipt-secret',
    'credential-sentinel-super-secret'
] as const;

const expectNoSensitiveSentinels = (value: unknown): void => {
    const serialized = JSON.stringify(value);
    for (const sentinel of sensitiveSentinels) expect(serialized).not.toContain(sentinel);
};

const strictBlockedKeys = ['message', 'reason', 'responseVersion', 'retryable', 'status'];

const expectExactBoundResponse = (
    response: unknown,
    expected: {
        hederaAccountId: string;
        sequenceNumber: string;
        bindingEventId: string;
        transactionId: string | null;
        resolutionSource: 'currentness-reconciled' | 'provider-existing' | 'provider-provisioned';
        boundAt?: string;
    }
): void => {
    expect(response).toEqual({
        responseVersion: 'v1',
        status: 'bound',
        identity,
        evmPublicAddress: request.evmPublicAddress,
        hederaAccountId: expected.hederaAccountId,
        bindingEventReceipt: {
            topicId: '0.0.999',
            sequenceNumber: expected.sequenceNumber,
            bindingEventId: expected.bindingEventId,
            transactionId: expected.transactionId
        },
        resolutionSource: expected.resolutionSource,
        serviceVersion: expect.any(String),
        boundAt: expected.boundAt ?? expect.any(String)
    });
};

const expectStrictBlockedEnvelope = (
    body: Record<string, unknown>,
    reason: IdentityRegistrationBlockedReasonV1
): void => {
    expect(Object.keys(body).sort()).toEqual(strictBlockedKeys);
    expect(body).toMatchObject({
        responseVersion: 'v1',
        status: 'blocked',
        reason,
        retryable: false,
        message: expect.any(String)
    });
};

const postRegistration = async (
    body: unknown = request,
    headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> => {
    const app = createApp();
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/identity-binding/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });
        return {
            status: response.status,
            body: await response.json() as Record<string, unknown>
        };
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
};

type TopicMessage = {
    consensus_timestamp: string;
    topic_id: string;
    sequence_number: number;
    payer_account_id?: string;
    message: string;
};

let topicHistory: TopicMessage[];

const signedEvidence = (
    overrides: Partial<Pick<IdentityRegistrationBindingEnvelopeV1, 'sub' | 'payload'>> = {}
): IdentityRegistrationBindingEnvelopeV1 => {
    const event: IdentityRegistrationBindingEnvelopeV1 = {
        t: 'IDENTITY_BIND',
        v: 1,
        sub: identity.canonicalDid,
        iat: '2026-10-24T18:01:00.000Z',
        chain: 'testnet',
        payload: {
            stable_identifier: identity.stableIdentifier,
            issuer: identity.issuer,
            evm_address: request.evmPublicAddress,
            hedera_account_id: '0.0.701',
            resolution_source: 'provider-provisioned',
            consent_receipt_ref: request.consentReceiptRef,
            requested_at: request.requestedAt
        },
        provenance: {
            schemaVersion: 1,
            authorityAccountId: '0.0.600',
            authorityKeyId: 'binding-key-v1',
            authorizationBasis: 'strategy-ruling-eugene-t1',
            authorizationBasisVersion: 'v1',
            signatureAlgorithm: 'EIP191_SECP256K1',
            scope: {
                purpose: 'TRUSTMESH_IDENTITY_CURRENTNESS',
                network: 'testnet',
                topicId: '0.0.999',
                schemaVersion: 1,
                normalizationVersion: 'exact-v1'
            },
            signature: ''
        }
    };
    Object.assign(event, overrides);
    event.provenance.signature = bindingSigningKey.sign(hashMessage(canonicalEvidencePayload(event))).serialized;
    return event;
};

const mirrorMessage = (sequence: number, event: unknown): TopicMessage => ({
    consensus_timestamp: `${1792864800 + sequence}.000000000`,
    topic_id: '0.0.999',
    sequence_number: sequence,
    payer_account_id: '0.0.600',
    message: Buffer.from(JSON.stringify(event)).toString('base64')
});

const pushTopicEvent = (event: unknown): TopicMessage => {
    const message = mirrorMessage(topicHistory.length + 1, event);
    topicHistory.push(message);
    return message;
};

const configureTopicReader = (): void => {
    (fetchMirrorTopicMessagesJson as jest.Mock).mockImplementation(async (path: string) => {
        const newest = [...topicHistory].sort((a, b) => b.sequence_number - a.sequence_number)[0];
        return path.includes('limit=1')
            ? { messages: newest ? [newest] : [], links: {} }
            : { messages: [...topicHistory].sort((a, b) => b.sequence_number - a.sequence_number), links: {} };
    });
};

const configureSigner = (privateKey = BINDING_PRIVATE_KEY): void => {
    const signer = new SigningKey(privateKey);
    (getHederaOperatorEvidenceSigner as jest.Mock).mockReturnValue({
        accountId: '0.0.600',
        publicKey: signer.publicKey,
        signMessage: (message: string) => signer.sign(hashMessage(message)).serialized
    });
};

beforeEach(() => {
    IdentityRegistrationService.resetProcessLocalStateForTests();
    jest.clearAllMocks();
    topicHistory = [];
    configureTopicReader();
    configureSigner();
    (reconcileEvmAlias as jest.Mock).mockResolvedValue({ status: 'absent' });
    (provisionAccountForEvmAlias as jest.Mock).mockResolvedValue({
        hederaAccountId: '0.0.701',
        transactionId: '0.0.600@1792864800.000000000'
    });
    (submitToTopic as jest.Mock).mockImplementation(async (_topic: string, message: string) => {
        const event = JSON.parse(message) as IdentityRegistrationBindingEnvelopeV1;
        const stored = pushTopicEvent(event);
        return {
            status: 'SUCCESS',
            transactionId: `0.0.600@1792864801.${String(stored.sequence_number).padStart(9, '0')}`,
            sequenceNumber: String(stored.sequence_number)
        };
    });
    config.BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID = '0.0.600';
    config.BINDING_EVIDENCE_AUTHORITY_KEY_ID = 'binding-key-v1';
    config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY = bindingSigningKey.publicKey;
    config.BINDING_EVIDENCE_AUTHORIZATION_BASIS = 'strategy-ruling-eugene-t1';
    config.HEDERA_NETWORK = 'testnet';
    config.HEDERA_OPERATOR_ID = '0.0.600';
    config.HEDERA_OPERATOR_KEY = BINDING_PRIVATE_KEY;
    config.WORLDS_BUILDER_SERVICE_TOKEN = 'worlds-builder-secret';
});

describe('IdentityRegistrationService', () => {
    it('creates a signed generic binding and the receipt reads as fresh CURRENT', async () => {
        const registered = await register();

        expectExactBoundResponse(registered, {
            hederaAccountId: '0.0.701',
            sequenceNumber: '1',
            bindingEventId: '0.0.999:1',
            transactionId: '0.0.600@1792864801.000000001',
            resolutionSource: 'provider-provisioned'
        });
        expect(topicHistory).toHaveLength(1);
        const event = JSON.parse(Buffer.from(topicHistory[0].message, 'base64').toString('utf8')) as IdentityRegistrationBindingEnvelopeV1;
        expect(event).toMatchObject({
            t: 'IDENTITY_BIND',
            sub: identity.canonicalDid,
            payload: {
                stable_identifier: identity.stableIdentifier,
                issuer: identity.issuer,
                evm_address: request.evmPublicAddress,
                consent_receipt_ref: request.consentReceiptRef,
                requested_at: request.requestedAt
            }
        });
        expect(event.payload).not.toHaveProperty('requested_role');
        expect(event.payload).not.toHaveProperty('organism_id');
        expect(event.provenance.signature).toMatch(/^0x[0-9a-f]+$/i);

        const currentness = await CurrentnessService.read({ requestVersion: 'v1', identity });
        expect(currentness).toMatchObject({
            disposition: 'CURRENT',
            binding: {
                hederaAccountId: '0.0.701',
                bindingEventId: '0.0.999:1',
                evmPublicAddress: request.evmPublicAddress
            }
        });
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
    });

    it('reuses an existing exact current binding without provisioning or submitting', async () => {
        pushTopicEvent(signedEvidence());

        const result = await register();

        expectExactBoundResponse(result, {
            hederaAccountId: '0.0.701',
            sequenceNumber: '1',
            bindingEventId: '0.0.999:1',
            transactionId: null,
            resolutionSource: 'currentness-reconciled',
            boundAt: '2026-10-24T18:01:00.000Z'
        });
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it('records a signed assertion when the provider already resolves the EVM alias', async () => {
        (reconcileEvmAlias as jest.Mock).mockResolvedValue({ status: 'resolved', hederaAccountId: '0.0.701' });

        const result = await register();
        const event = JSON.parse(Buffer.from(topicHistory[0].message, 'base64').toString('utf8')) as IdentityRegistrationBindingEnvelopeV1;

        expectExactBoundResponse(result, {
            hederaAccountId: '0.0.701',
            sequenceNumber: '1',
            bindingEventId: '0.0.999:1',
            transactionId: '0.0.600@1792864801.000000001',
            resolutionSource: 'provider-existing'
        });
        expect(event.t).toBe('IDENTITY_ASSERT');
        expect(event.payload.resolution_source).toBe('provider-existing');
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
    });

    it('blocks a current identity binding whose exact EVM address differs', async () => {
        pushTopicEvent(signedEvidence({
            payload: { ...signedEvidence().payload, evm_address: '0x2222222222222222222222222222222222222222' }
        }));

        const result = await register();

        expect(result).toMatchObject({ status: 'blocked', reason: 'IDENTITY_CONFLICT' });
        expect(reconcileEvmAlias).not.toHaveBeenCalled();
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it.each([
        ['subject', { sub: 'did:magic:issuer:other-user' }],
        ['issuer', { payload: { ...signedEvidence().payload, issuer: 'https://other-issuer.example' } }]
    ])('blocks exact %s mismatch in existing evidence', async (_label, override) => {
        pushTopicEvent(signedEvidence(override));

        const result = await register();

        expect(result).toMatchObject({ status: 'blocked', reason: 'CURRENTNESS_NOT_CURRENT' });
        expect(reconcileEvmAlias).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it('makes an idempotent retry return the same attributable event', async () => {
        const first = await register();
        const retry = await register();

        expect(retry).toEqual(first);
        expect(submitToTopic).toHaveBeenCalledTimes(1);
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
    });

    it('blocks changed input that reuses a completed idempotency key', async () => {
        await register();

        const changed = await register({
            ...request,
            consentReceiptRef: 'cw-consent:different-receipt'
        });

        expect(changed).toMatchObject({ status: 'blocked', reason: 'IDEMPOTENCY_KEY_REUSE' });
        expect(submitToTopic).toHaveBeenCalledTimes(1);
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
    });

    it('expires completed outcomes deterministically at the configured TTL', () => {
        let now = 1000;
        const cache = new IdentityRegistrationCompletedOutcomeCache(100, 2, () => now);
        const outcome = {
            responseVersion: 'v1' as const,
            status: 'blocked' as const,
            reason: 'CURRENTNESS_UNAVAILABLE' as const,
            retryable: false as const,
            message: 'test outcome'
        };

        expect(cache.store('key-1', 'fingerprint-1', outcome)).toBe(true);
        now = 1099;
        expect(cache.lookup('key-1', 'fingerprint-1')).toEqual({ status: 'hit', response: outcome });
        now = 1100;
        expect(cache.lookup('key-1', 'fingerprint-1')).toEqual({ status: 'miss' });
        expect(cache.size).toBe(0);
    });

    it('keeps the completed-outcome cache within its maximum entry count', () => {
        let now = 2000;
        const cache = new IdentityRegistrationCompletedOutcomeCache(100, 2, () => now);
        const outcome = {
            responseVersion: 'v1' as const,
            status: 'blocked' as const,
            reason: 'CURRENTNESS_UNAVAILABLE' as const,
            retryable: false as const,
            message: 'test outcome'
        };

        expect(cache.store('key-1', 'fingerprint-1', outcome)).toBe(true);
        expect(cache.store('key-2', 'fingerprint-2', outcome)).toBe(true);
        expect(cache.store('key-3', 'fingerprint-3', outcome)).toBe(false);
        expect(cache.size).toBe(2);

        now = 2100;
        expect(cache.hasCapacity()).toBe(true);
        expect(cache.store('key-3', 'fingerprint-3', outcome)).toBe(true);
        expect(cache.size).toBe(1);
    });

    it('coalesces concurrent same-identity and same-key requests into one receipt', async () => {
        let releaseAlias: (value: { status: 'absent' }) => void = () => undefined;
        (reconcileEvmAlias as jest.Mock).mockReturnValueOnce(new Promise(resolve => { releaseAlias = resolve; }));

        const first = register();
        const duplicate = register();
        releaseAlias({ status: 'absent' });
        const [a, b] = await Promise.all([first, duplicate]);

        expect(a).toEqual(b);
        expect(submitToTopic).toHaveBeenCalledTimes(1);
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
    });

    it('keeps registration blocked after an uncertain provision and permits currentness-only follow-up', async () => {
        (provisionAccountForEvmAlias as jest.Mock)
            .mockRejectedValueOnce(new Error('provider timeout'));
        (reconcileEvmAlias as jest.Mock)
            .mockResolvedValueOnce({ status: 'absent' })
            .mockResolvedValueOnce({ status: 'absent' });

        const first = await register();
        expect(first).toMatchObject({ status: 'pending', reason: 'PROVIDER_OUTCOME_UNCERTAIN', retryable: true });
        expect(topicHistory).toHaveLength(0);

        const exactRetry = await register();
        expect(exactRetry).toEqual(first);

        const newRegistration = await register({ ...request, idempotencyKey: 'registration-retry' });
        expect(newRegistration).toMatchObject({
            status: 'blocked',
            reason: 'UNCERTAIN_OUTCOME_BLOCKED'
        });
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);

        const reconciled = await CurrentnessService.read({ requestVersion: 'v1', identity });
        expect(reconciled.disposition).toBe('UNBOUND');

        const afterCurrentness = await register({ ...request, idempotencyKey: 'registration-after-currentness' });
        expect(afterCurrentness).toMatchObject({
            status: 'blocked',
            reason: 'UNCERTAIN_OUTCOME_BLOCKED'
        });
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
        expect(fetchMirrorTopicMessagesJson).toHaveBeenCalledTimes(6);
    });

    it('returns an exact current binding after uncertain provisioning without another provider write', async () => {
        (provisionAccountForEvmAlias as jest.Mock).mockImplementationOnce(async () => {
            pushTopicEvent(signedEvidence());
            throw new Error('provider timeout');
        });

        const result = await register();

        expectExactBoundResponse(result, {
            hederaAccountId: '0.0.701',
            sequenceNumber: '1',
            bindingEventId: '0.0.999:1',
            transactionId: null,
            resolutionSource: 'currentness-reconciled',
            boundAt: '2026-10-24T18:01:00.000Z'
        });
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
        expect(reconcileEvmAlias).toHaveBeenCalledTimes(1);
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it('does not publish after uncertain provisioning when UNBOUND currentness meets a resolved alias', async () => {
        (provisionAccountForEvmAlias as jest.Mock).mockRejectedValueOnce(new Error('provider timeout'));
        let aliasLookups = 0;
        (reconcileEvmAlias as jest.Mock).mockImplementation(async () => {
            aliasLookups += 1;
            return aliasLookups === 1
                ? { status: 'absent' }
                : { status: 'resolved', hederaAccountId: '0.0.702' };
        });

        const result = await register();

        expect(result).toMatchObject({
            status: 'pending',
            reason: 'PROVIDER_OUTCOME_UNCERTAIN',
            retryable: true
        });
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
        expect(reconcileEvmAlias).toHaveBeenCalledTimes(1);
        expect(submitToTopic).not.toHaveBeenCalled();
        expect(topicHistory).toHaveLength(0);
    });

    it('reconciles an uncertain HCS submit and returns its observed current receipt', async () => {
        (submitToTopic as jest.Mock).mockImplementationOnce(async (_topic: string, message: string) => {
            pushTopicEvent(JSON.parse(message));
            throw new Error('submit response lost');
        });

        const result = await register();

        expectExactBoundResponse(result, {
            hederaAccountId: '0.0.701',
            sequenceNumber: '1',
            bindingEventId: '0.0.999:1',
            transactionId: null,
            resolutionSource: 'currentness-reconciled'
        });
        expect(submitToTopic).toHaveBeenCalledTimes(1);
        expect(provisionAccountForEvmAlias).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the configured binding authority does not match the operator signer', async () => {
        config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY = new SigningKey(OTHER_PRIVATE_KEY).publicKey;

        const result = await register();

        expect(result).toMatchObject({ status: 'blocked', reason: 'AUTHORITY_SIGNER_MISMATCH' });
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it('fails closed when binding evidence authority configuration is incomplete', async () => {
        config.BINDING_EVIDENCE_AUTHORITY_KEY_ID = undefined;

        const result = await register();

        expect(result).toMatchObject({ status: 'blocked', reason: 'INVALID_AUTHORITY_CONFIGURATION' });
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
        expect(submitToTopic).not.toHaveBeenCalled();
    });

    it('derives EIP-191 signing material from the actual ECDSA operator key', () => {
        const actualClient = jest.requireActual('../hedera/client') as typeof import('../hedera/client');
        const signer = actualClient.getHederaOperatorEvidenceSigner();
        const signature = signer.signMessage('registration signer check');

        expect(signer.accountId).toBe('0.0.600');
        expect(verifyMessage('registration signer check', signature)).toBe(computeAddress(signer.publicKey));
        expect(signer.publicKey).toBe(bindingSigningKey.publicKey);
    });

    it('scrubs identity values from the exceptional EVM lookup warning', async () => {
        const leakedError = new TypeError(`lookup failed for ${sensitiveSentinels.join(' ')}`);
        const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(leakedError);

        try {
            const actualClient = jest.requireActual('../hedera/client') as typeof import('../hedera/client');
            await expect(actualClient.lookupAccountByEvm(sensitiveSentinels[1])).resolves.toBeNull();

            expect(log.warn).toHaveBeenCalledWith('Mirror EVM account lookup failed', {
                classification: 'MIRROR_NETWORK_ERROR'
            });
            expectNoSensitiveSentinels((log.warn as jest.Mock).mock.calls);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('logs only a bounded classification for Hedera initialization failures', () => {
        const actualClient = jest.requireActual('../hedera/client') as typeof import('../hedera/client');
        config.HEDERA_OPERATOR_KEY = sensitiveSentinels.join('|');

        expect(() => actualClient.getHederaClient()).toThrow();
        expect(log.error).toHaveBeenCalledWith('Failed to initialize Hedera client', undefined, {
            classification: 'HEDERA_INITIALIZATION_ERROR'
        });
        expectNoSensitiveSentinels((log.error as jest.Mock).mock.calls);
    });

    it('logs only a bounded classification for Hedera submission failures', async () => {
        const actualClient = jest.requireActual('../hedera/client') as typeof import('../hedera/client');
        const hederaClient = actualClient.getHederaClient();
        const executeSpy = jest.spyOn(TopicMessageSubmitTransaction.prototype, 'execute')
            .mockRejectedValue(new Error(`submission failed for ${sensitiveSentinels.join(' ')}`));

        try {
            await expect(actualClient.submitToTopic(
                config.IDENTITY_TOPIC_ID,
                JSON.stringify({ sensitiveSentinels })
            )).rejects.toThrow();
            expect(log.error).toHaveBeenCalledWith('Failed to submit to topic', undefined, {
                classification: 'HEDERA_SUBMISSION_ERROR'
            });
            expectNoSensitiveSentinels((log.error as jest.Mock).mock.calls);
        } finally {
            executeSpy.mockRestore();
            await hederaClient.close();
        }
    });

    it('does not treat unsigned legacy evidence as current or proceed to provision', async () => {
        const unsigned = signedEvidence();
        delete (unsigned as Partial<IdentityRegistrationBindingEnvelopeV1>).provenance;
        pushTopicEvent(unsigned);

        const currentness = await CurrentnessService.read({ requestVersion: 'v1', identity });
        expect(currentness.disposition).toBe('UNKNOWN_STALE');

        const result = await register();
        expect(result).toMatchObject({ status: 'blocked', reason: 'CURRENTNESS_NOT_CURRENT' });
        expect(reconcileEvmAlias).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
    });

    it('returns a strict v1 failure when registration authentication is unavailable', async () => {
        config.WORLDS_BUILDER_SERVICE_TOKEN = undefined;

        const response = await postRegistration();

        expect(response.status).toBe(503);
        expectStrictBlockedEnvelope(response.body, 'SERVICE_AUTHENTICATION_UNAVAILABLE');
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
    });

    it('returns a strict v1 failure for an invalid Worlds Builder service token', async () => {
        const response = await postRegistration(request, {
            'x-worlds-builder-service-token': 'wrong-token'
        });

        expect(response.status).toBe(401);
        expectStrictBlockedEnvelope(response.body, 'AUTHENTICATION_FAILURE');
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
    });

    it('returns a strict v1 failure when the durable operation owner is absent', async () => {
        const response = await postRegistration(request, {
            'x-worlds-builder-service-token': 'worlds-builder-secret'
        });

        expect(response.status).toBe(428);
        expectStrictBlockedEnvelope(response.body, 'OPERATION_OWNER_REQUIRED');
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
    });

    it('returns a strict v1 failure for invalid request fields without validation details', async () => {
        const response = await postRegistration(
            { ...request, requestedRole: 'foundingSteward', organismId: 'world-1' },
            {
                'x-worlds-builder-service-token': 'worlds-builder-secret',
                'x-trustmesh-operation-owner': operationOwnerRef
            }
        );

        expect(response.status).toBe(400);
        expectStrictBlockedEnvelope(response.body, 'INVALID_REQUEST');
        expect(response.body).not.toHaveProperty('details');
        expect(fetchMirrorTopicMessagesJson).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
    });

    it('returns a strict v1 failure for an internal registration failure', async () => {
        const sentinel = sensitiveSentinels.join(' ');
        const registerSpy = jest.spyOn(IdentityRegistrationService, 'register')
            .mockRejectedValueOnce(new Error(sentinel));
        try {
            const response = await postRegistration(request, {
                'x-worlds-builder-service-token': 'worlds-builder-secret',
                'x-trustmesh-operation-owner': operationOwnerRef
            });

            expect(response.status).toBe(500);
            expectStrictBlockedEnvelope(response.body, 'INTERNAL_FAILURE');
            expectNoSensitiveSentinels(response.body);
        } finally {
            registerSpy.mockRestore();
        }
    });
});
