import { createApp } from '../../app';
import { canonicalEvidencePayload, CurrentnessReadError, CurrentnessService } from './currentnessService';
import { fetchMirrorJson, provisionAccountForEvmAlias, submitToTopic } from '../hedera/client';
import type { IdentityLifecycleEventV1 } from './types';
import { config } from '../../config';
import { hashMessage, SigningKey } from 'ethers';

const BINDING_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const LIFECYCLE_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const WRONG_PRIVATE_KEY = `0x${'33'.repeat(32)}`;

jest.mock('../../config', () => ({
    config: {
        HEDERA_NETWORK: 'testnet',
        IDENTITY_TOPIC_ID: '0.0.999',
        RESOLVE_MAX_PAGES: 2,
        CURRENTNESS_VALIDITY_MS: 30000,
        CURRENTNESS_SERVICE_TOKEN: 'reader-secret',
        BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID: '0.0.600',
        BINDING_EVIDENCE_AUTHORITY_KEY_ID: 'binding-key-v1',
        BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY: '0x044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1',
        BINDING_EVIDENCE_AUTHORIZATION_BASIS: 'binding-producer-ruling-v1',
        LIFECYCLE_AUTHORITY_ACCOUNT_ID: '0.0.700',
        LIFECYCLE_AUTHORITY_KEY_ID: 'lifecycle-key-v1',
        LIFECYCLE_AUTHORITY_PUBLIC_KEY: '0x04466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276728176c3c6431f8eeda4538dc37c865e2784f3a9e77d044f33e407797e1278a',
        LIFECYCLE_AUTHORIZATION_BASIS: 'strategy-ruling-eugene-t1',
        WORLDS_BUILDER_SERVICE_TOKEN: 'worlds-builder-secret',
        CORS_ORIGINS: '*',
        MAGIC_JWT_ENABLED: 'false'
    }
}));

jest.mock('../../util/log', () => ({
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));

jest.mock('../hedera/client', () => ({
    fetchMirrorJson: jest.fn(),
    lookupAccountByEvm: jest.fn(),
    provisionAccountForEvmAlias: jest.fn(),
    submitToTopic: jest.fn()
}));

const identity = {
    canonicalDid: 'did:magic:issuer:user-1',
    stableIdentifier: 'issuer:user-1',
    issuer: 'https://issuer.example'
};

const request = { requestVersion: 'v1' as const, identity };

const mirrorMessage = (
    sequence: number,
    event: unknown,
    payerAccountId: string | null = '0.0.600'
) => ({
    consensus_timestamp: `${1700000000 + sequence}.000000000`,
    topic_id: '0.0.999',
    sequence_number: sequence,
    payer_account_id: payerAccountId ?? undefined,
    message: Buffer.from(JSON.stringify(event)).toString('base64')
});

const signEvidence = <T extends { provenance: { signature: string } }>(
    event: T,
    privateKey: string
): T => {
    event.provenance.signature = new SigningKey(privateKey)
        .sign(hashMessage(canonicalEvidencePayload(event)))
        .serialized;
    return event;
};

const binding = (
    accountId: string,
    issuedAt = '2026-10-23T00:00:00.000Z',
    type: 'IDENTITY_BIND' | 'IDENTITY_ASSERT' = 'IDENTITY_BIND',
    issuer = identity.issuer,
    privateKey = BINDING_PRIVATE_KEY
) => signEvidence({
    t: type,
    v: 1,
    sub: identity.canonicalDid,
    iat: issuedAt,
    chain: 'testnet',
    payload: {
        stable_identifier: identity.stableIdentifier,
        issuer,
        evm_address: '0x1111111111111111111111111111111111111111',
        hedera_account_id: accountId,
        claim_id: 'claim-1',
        organism_id: 'organism-1',
        source_assessment_id: 'assessment-1',
        source_intake_id: 'intake-1',
        source_report_id: 'report-1',
        source_compiler_run_id: 'compiler-1',
        requested_role: 'foundingSteward',
        resolution_source: 'resolved' as const
    },
    provenance: {
        schemaVersion: 1 as const,
        authorityAccountId: '0.0.600',
        authorityKeyId: 'binding-key-v1',
        authorizationBasis: 'binding-producer-ruling-v1',
        authorizationBasisVersion: 'v1' as const,
        signatureAlgorithm: 'EIP191_SECP256K1' as const,
        signature: ''
    }
}, privateKey);

const reference = (sequence: number) => ({
    ...identity,
    network: 'testnet' as const,
    topicId: '0.0.999',
    bindingEventId: `0.0.999:${sequence}`,
    schemaVersion: 1 as const,
    normalizationVersion: 'v1' as const
});

const lifecycle = (
    type: 'IDENTITY_REVOKE' | 'IDENTITY_SUPERSEDE',
    targetSequence: number,
    options: { id?: string; replacementSequence?: number; evidenceRef?: string; privateKey?: string } = {}
): IdentityLifecycleEventV1 => signEvidence({
    type,
    schemaVersion: 1,
    normalizationVersion: 'v1',
    lifecycleEventId: options.id ?? `lifecycle-${targetSequence}`,
    target: reference(targetSequence),
    ...(type === 'IDENTITY_SUPERSEDE'
        ? { replacement: reference(options.replacementSequence!) }
        : {}),
    sourceEventAt: '2026-10-23T00:01:00.000Z',
    provenance: {
        schemaVersion: 1,
        authorityAccountId: '0.0.700',
        authorityKeyId: 'lifecycle-key-v1',
        authorizationBasis: 'strategy-ruling-eugene-t1',
        authorizationBasisVersion: 'v1',
        signatureAlgorithm: 'EIP191_SECP256K1',
        signature: ''
    },
    evidenceRef: options.evidenceRef ?? `evidence:${targetSequence}`
}, options.privateKey ?? LIFECYCLE_PRIVATE_KEY);

const mockCompleteTopic = (messages: ReturnType<typeof mirrorMessage>[]) => {
    const newest = [...messages].sort((a, b) => b.sequence_number - a.sequence_number)[0];
    (fetchMirrorJson as jest.Mock)
        .mockResolvedValueOnce({ messages: newest ? [newest] : [], links: {} })
        .mockResolvedValueOnce({
            messages: [...messages].sort((a, b) => b.sequence_number - a.sequence_number),
            links: {}
        });
};

describe('CurrentnessService conformance', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns CURRENT only after complete coverage through the declared watermark', async () => {
        mockCompleteTopic([mirrorMessage(1, binding('0.0.101'))]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('CURRENT');
        expect(result.binding?.hederaAccountId).toBe('0.0.101');
        expect(result.authoritativeWatermark).toMatchObject({
            sequenceNumber: 1,
            coverageComplete: true
        });
        expect(result.validUntil).not.toBe(result.observedAt);
    });

    it('keeps revocation effective despite a later ordinary assertion', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1), '0.0.700'),
            mirrorMessage(3, binding('0.0.101', '2026-10-23T00:02:00.000Z', 'IDENTITY_ASSERT'))
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('REVOKED');
        expect(result.reason).toBe('VALID_REVOCATION');
        expect(result.lifecycle?.evidenceRef).toBe('evidence:1');
        expect(result.lifecycle?.sourceEventAt).toBe('2026-10-23T00:01:00.000Z');
        expect(result.lifecycle?.effectiveAt).toBe('2023-11-14T22:13:22.000Z');
    });

    it('returns SUPERSEDED only when the exact replacement binding exists first', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, binding('0.0.202', '2026-10-23T00:00:30.000Z')),
            mirrorMessage(3, lifecycle('IDENTITY_SUPERSEDE', 1, {
                replacementSequence: 2,
                evidenceRef: 'evidence:supersession'
            }), '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('SUPERSEDED');
        expect(result.binding?.hederaAccountId).toBe('0.0.101');
        expect(result.replacementBinding).toEqual({
            hederaAccountId: '0.0.202',
            bindingEventId: '0.0.999:2'
        });
    });

    it('returns UNBOUND for a completely scanned empty topic', async () => {
        mockCompleteTopic([]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNBOUND');
        expect(result.reason).toBe('NO_BINDING');
    });

    it('returns AMBIGUOUS for conflicting unlinked bindings', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, binding('0.0.202'))
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('AMBIGUOUS');
        expect(result.reason).toBe('CONFLICTING_LINEAGE');
    });

    it('returns AMBIGUOUS for a supported binding with conflicting issuer lineage', async () => {
        const conflicting = binding(
            '0.0.101',
            '2026-10-23T00:00:00.000Z',
            'IDENTITY_BIND',
            'https://other-issuer.example'
        );
        mockCompleteTopic([mirrorMessage(1, conflicting)]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('AMBIGUOUS');
        expect(result.reason).toBe('CONFLICTING_LINEAGE');
    });

    it('returns UNKNOWN_STALE when pagination does not cover the watermark', async () => {
        (fetchMirrorJson as jest.Mock)
            .mockResolvedValueOnce({ messages: [mirrorMessage(3, binding('0.0.101'))] })
            .mockResolvedValueOnce({
                messages: [mirrorMessage(3, binding('0.0.101'))],
                links: { next: '/page-2' }
            })
            .mockResolvedValueOnce({
                messages: [mirrorMessage(2, { unrelated: true })],
                links: { next: '/page-3' }
            });

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('INCOMPLETE_PAGINATION');
        expect(result.authoritativeWatermark.coverageComplete).toBe(false);
    });

    it('treats an exact lifecycle replay as idempotent', async () => {
        const revoke = lifecycle('IDENTITY_REVOKE', 1, { id: 'revoke-1' });
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, revoke, '0.0.700'),
            mirrorMessage(3, revoke, '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('REVOKED');
    });

    it('returns AMBIGUOUS for a duplicate lifecycle id with conflicting content', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1, {
                id: 'transition-1',
                evidenceRef: 'evidence:a'
            }), '0.0.700'),
            mirrorMessage(3, lifecycle('IDENTITY_REVOKE', 1, {
                id: 'transition-1',
                evidenceRef: 'evidence:b'
            }), '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('AMBIGUOUS');
    });

    it('returns UNKNOWN_STALE when supersession replacement evidence is missing', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_SUPERSEDE', 1, {
                replacementSequence: 99
            }), '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('INCOMPLETE_EVIDENCE');
    });

    it('does not invoke submit or provisioning paths', async () => {
        mockCompleteTopic([mirrorMessage(1, binding('0.0.101'))]);

        await CurrentnessService.read(request);

        expect(submitToTopic).not.toHaveBeenCalled();
        expect(provisionAccountForEvmAlias).not.toHaveBeenCalled();
    });

    it('distinguishes unresolved writer attribution from a valid lifecycle event', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1), null)
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNRESOLVED_WRITER_ATTRIBUTION');
    });

    it('fails closed on a self-asserted lifecycle authority with the wrong payer', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1), '0.0.701')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNVERIFIED_WRITER_PROVENANCE');
    });

    it('rejects an unsigned legacy binding even when the payer matches', async () => {
        const { provenance: _provenance, ...unsigned } = binding('0.0.101');
        mockCompleteTopic([mirrorMessage(1, unsigned)]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNVERIFIED_WRITER_PROVENANCE');
    });

    it('rejects payer-only binding evidence without a signature', async () => {
        const payerOnly = binding('0.0.101');
        payerOnly.provenance.signature = '';
        mockCompleteTopic([mirrorMessage(1, payerOnly)]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNVERIFIED_WRITER_PROVENANCE');
    });

    it('rejects a binding signed by the wrong key', async () => {
        mockCompleteTopic([mirrorMessage(1, binding(
            '0.0.101',
            '2026-10-23T00:00:00.000Z',
            'IDENTITY_BIND',
            identity.issuer,
            WRONG_PRIVATE_KEY
        ))]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNVERIFIED_WRITER_PROVENANCE');
    });

    it('rejects a lifecycle event signed by a forged self-asserted authority', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1, {
                privateKey: WRONG_PRIVATE_KEY
            }), '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNVERIFIED_WRITER_PROVENANCE');
    });

    it('fails closed on an applicable unknown identity lifecycle type', async () => {
        const unknown = lifecycle('IDENTITY_REVOKE', 1) as unknown as {
            type: string;
            provenance: IdentityLifecycleEventV1['provenance'];
            [key: string]: unknown;
        };
        unknown.type = 'IDENTITY_SUSPEND';
        signEvidence(unknown, LIFECYCLE_PRIVATE_KEY);
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, unknown, '0.0.700')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNSUPPORTED_EVIDENCE');
    });

    it.each([
        [Object.assign(new Error('request aborted'), { name: 'AbortError' }), 'TIMEOUT'],
        [new TypeError('connection refused'), 'TEMPORARY_OUTAGE'],
        [Object.assign(new Error('unauthorized'), { status: 401 }), 'UPSTREAM_AUTHENTICATION_FAILURE'],
        [Object.assign(new Error('forbidden'), { status: 403 }), 'UPSTREAM_AUTHENTICATION_FAILURE'],
        [Object.assign(new Error('missing'), { status: 404 }), 'UPSTREAM_CAPABILITY_ABSENT'],
        [Object.assign(new Error('bad request'), { status: 400 }), 'UPSTREAM_PERMANENT_FAILURE'],
        [Object.assign(new Error('unavailable'), { status: 503 }), 'TEMPORARY_OUTAGE']
    ])('classifies mirror failures without treating permanent errors as outages', async (failure, expectedCode) => {
        (fetchMirrorJson as jest.Mock).mockRejectedValueOnce(failure);

        await expect(CurrentnessService.read(request)).rejects.toMatchObject({
            code: expectedCode
        });
    });

    it('reports capability absence when lifecycle authority is not configured', () => {
        const previous = config.LIFECYCLE_AUTHORITY_ACCOUNT_ID;
        config.LIFECYCLE_AUTHORITY_ACCOUNT_ID = undefined;
        try {
            expect(() => CurrentnessService.assertCapability()).toThrow(
                expect.objectContaining<Partial<CurrentnessReadError>>({ code: 'CAPABILITY_ABSENT' })
            );
        } finally {
            config.LIFECYCLE_AUTHORITY_ACCOUNT_ID = previous;
        }
    });
});

describe('POST /v1/currentness authentication', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('rejects an unauthenticated request before reading currentness', async () => {
        const app = createApp();
        const server = app.listen(0);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

        try {
            const response = await fetch(`http://127.0.0.1:${address.port}/v1/currentness`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request)
            });
            const body = await response.json() as { code: string };

            expect(response.status).toBe(401);
            expect(body.code).toBe('AUTHENTICATION_FAILURE');
            expect(fetchMirrorJson).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    it('returns the versioned currentness contract for an authenticated read', async () => {
        mockCompleteTopic([mirrorMessage(1, binding('0.0.101'))]);
        const app = createApp();
        const server = app.listen(0);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

        try {
            const response = await fetch(`http://127.0.0.1:${address.port}/v1/currentness`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-trustmesh-currentness-token': 'reader-secret'
                },
                body: JSON.stringify(request)
            });
            const body = await response.json() as { responseVersion: string; disposition: string };

            expect(response.status).toBe(200);
            expect(body).toMatchObject({ responseVersion: 'v1', disposition: 'CURRENT' });
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });
});
