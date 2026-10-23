import { createApp } from '../../app';
import { CurrentnessReadError, CurrentnessService } from './currentnessService';
import { fetchMirrorJson, provisionAccountForEvmAlias, submitToTopic } from '../hedera/client';
import type { IdentityLifecycleEventV1 } from './types';
import { config } from '../../config';

jest.mock('../../config', () => ({
    config: {
        HEDERA_NETWORK: 'testnet',
        IDENTITY_TOPIC_ID: '0.0.999',
        RESOLVE_MAX_PAGES: 2,
        CURRENTNESS_VALIDITY_MS: 30000,
        CURRENTNESS_SERVICE_TOKEN: 'reader-secret',
        LIFECYCLE_AUTHORITY_ACCOUNT_ID: '0.0.700',
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
    payerAccountId?: string
) => ({
    consensus_timestamp: `${1700000000 + sequence}.000000000`,
    topic_id: '0.0.999',
    sequence_number: sequence,
    payer_account_id: payerAccountId,
    message: Buffer.from(JSON.stringify(event)).toString('base64')
});

const binding = (accountId: string, issuedAt = '2026-10-23T00:00:00.000Z') => ({
    t: 'IDENTITY_BIND',
    v: 1,
    sub: identity.canonicalDid,
    iat: issuedAt,
    chain: 'testnet',
    payload: {
        stable_identifier: identity.stableIdentifier,
        issuer: identity.issuer,
        evm_address: '0x1111111111111111111111111111111111111111',
        hedera_account_id: accountId,
        claim_id: 'claim-1',
        organism_id: 'organism-1',
        source_assessment_id: 'assessment-1',
        source_intake_id: 'intake-1',
        source_report_id: 'report-1',
        source_compiler_run_id: 'compiler-1',
        requested_role: 'foundingSteward',
        resolution_source: 'resolved'
    }
});

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
    options: { id?: string; replacementSequence?: number; evidenceRef?: string } = {}
): IdentityLifecycleEventV1 => ({
    type,
    schemaVersion: 1,
    normalizationVersion: 'v1',
    lifecycleEventId: options.id ?? `lifecycle-${targetSequence}`,
    target: reference(targetSequence),
    ...(type === 'IDENTITY_SUPERSEDE'
        ? { replacement: reference(options.replacementSequence!) }
        : {}),
    sourceEventAt: '2026-10-23T00:01:00.000Z',
    authority: {
        accountId: '0.0.700',
        authorizationBasis: 'strategy-ruling-eugene-t1'
    },
    evidenceRef: options.evidenceRef ?? `evidence:${targetSequence}`
});

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
            mirrorMessage(3, { ...binding('0.0.101'), t: 'IDENTITY_ASSERT' })
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
        const conflicting = binding('0.0.101');
        conflicting.payload.issuer = 'https://other-issuer.example';
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
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1))
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('UNKNOWN_STALE');
        expect(result.reason).toBe('UNRESOLVED_WRITER_ATTRIBUTION');
    });

    it('does not accept lifecycle events from a resolved but unauthorized writer', async () => {
        mockCompleteTopic([
            mirrorMessage(1, binding('0.0.101')),
            mirrorMessage(2, lifecycle('IDENTITY_REVOKE', 1), '0.0.701')
        ]);

        const result = await CurrentnessService.read(request);

        expect(result.disposition).toBe('CURRENT');
    });

    it.each([
        [Object.assign(new Error('request aborted'), { name: 'AbortError' }), 'TIMEOUT'],
        [new Error('connection refused'), 'TRANSPORT_OUTAGE']
    ])('classifies mirror failures distinctly', async (failure, expectedCode) => {
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
