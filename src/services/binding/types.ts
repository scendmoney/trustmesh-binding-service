export interface BindRequest {
    worldId: string;
    evmAddress: string;
    hederaAccountId: string;
    proof: {
        type: 'magic_jwt' | 'sig' | 'otp_attestation';
        value: string;
    };
}

export interface BindingEvent {
    type: 'IDENTITY_BINDING';
    worldId: string;
    evmAddress: string;
    hederaAccountId: string;
    createdAt: number;
    proofType: string;
    payloadHash?: string;
}

export interface ResolveResult {
    worldId: string;
    evm: string;
    hederaAccountId: string | null;
    bindingEventId: string | null;
    updatedAt: number | null;
}

export interface BindingStatus {
    worldId: string;
    a: string;
    b: string;
    isBound: boolean;
    bindingEventId: string | null;
}

export interface FounderBindingRequest {
    founder: {
        issuer: string;
        stableIdentifier: string;
        canonicalDid: string;
        displayName?: string;
        email?: string;
        evmPublicAddress?: string;
    };
    claimIntent: {
        claimVersion: 'v0.1';
        claimId: string;
        requestedAt: string;
        organismId: string;
        sourceAssessmentId: string;
        sourceIntakeId: string;
        sourceReportId: string;
        sourceCompilerRunId: string;
        requestedRole: 'foundingSteward';
    };
}

export type FounderBindingFailureReason =
    | 'notFound'
    | 'notDurable'
    | 'serviceUnavailable'
    | 'unauthorized'
    | 'conflict';

export interface FounderBindingSuccessResponse {
    status: 'bound';
    binding: {
        bindingVersion: 'v0.1';
        canonicalDid: string;
        stableIdentifier: string;
        hederaAccountId: string;
        bindingEventId: string;
        resolutionSource: 'resolved' | 'provisioned';
        serviceVersion: string;
        boundAt: string;
        isDurable: true;
    };
}

export interface FounderBindingFailureResponse {
    status: 'unbound';
    reason: FounderBindingFailureReason;
    message: string;
}

export type FounderBindingResponse =
    | FounderBindingSuccessResponse
    | FounderBindingFailureResponse;

export interface FounderBindingEnvelope {
    t: 'IDENTITY_BIND' | 'IDENTITY_ASSERT';
    v: 1;
    sub: string;
    iat: string;
    chain: 'testnet' | 'mainnet' | 'previewnet';
    payload: {
        stable_identifier: string;
        issuer: string;
        evm_address: string;
        hedera_account_id: string;
        claim_id: string;
        organism_id: string;
        source_assessment_id: string;
        source_intake_id: string;
        source_report_id: string;
        source_compiler_run_id: string;
        requested_role: 'foundingSteward';
        resolution_source: 'resolved' | 'provisioned';
        create_tx_id?: string | null;
        reason?: string | null;
    };
}

export type CurrentnessDisposition =
    | 'CURRENT'
    | 'REVOKED'
    | 'SUPERSEDED'
    | 'UNBOUND'
    | 'AMBIGUOUS'
    | 'UNKNOWN_STALE';

export interface CurrentnessIdentity {
    canonicalDid: string;
    stableIdentifier: string;
    issuer: string;
}

export interface CurrentnessRequest {
    requestVersion: 'v1';
    identity: CurrentnessIdentity;
}

export interface BindingReference extends CurrentnessIdentity {
    network: 'testnet' | 'mainnet' | 'previewnet';
    topicId: string;
    bindingEventId: string;
    schemaVersion: 1;
    normalizationVersion: 'v1';
}

export interface IdentityLifecycleEventV1 {
    type: 'IDENTITY_REVOKE' | 'IDENTITY_SUPERSEDE';
    schemaVersion: 1;
    normalizationVersion: 'v1';
    lifecycleEventId: string;
    target: BindingReference;
    replacement?: BindingReference;
    sourceEventAt: string;
    authority: {
        accountId: string;
        authorizationBasis: string;
    };
    evidenceRef: string;
}

export type CurrentnessReason =
    | 'ACTIVE_AT_WATERMARK'
    | 'VALID_REVOCATION'
    | 'VALID_SUPERSESSION'
    | 'NO_BINDING'
    | 'CONFLICTING_LINEAGE'
    | 'INCOMPLETE_PAGINATION'
    | 'INCOMPLETE_EVIDENCE'
    | 'UNSUPPORTED_EVIDENCE'
    | 'UNRESOLVED_WRITER_ATTRIBUTION';

export interface CurrentnessResponse {
    responseVersion: 'v1';
    disposition: CurrentnessDisposition;
    reason: CurrentnessReason;
    identity: CurrentnessIdentity;
    binding: {
        hederaAccountId: string;
        bindingEventId: string;
        sourceEventAt: string;
        effectiveAt: string;
    } | null;
    replacementBinding: {
        hederaAccountId: string;
        bindingEventId: string;
    } | null;
    lifecycle: {
        type: IdentityLifecycleEventV1['type'];
        lifecycleEventId: string;
        sourceEventAt: string;
        effectiveAt: string;
        authorityAccountId: string;
        authorizationBasis: string;
        evidenceRef: string;
    } | null;
    evidenceRef: string;
    serviceVersion: string;
    observedAt: string;
    validUntil: string;
    authoritativeWatermark: {
        network: 'testnet' | 'mainnet' | 'previewnet';
        topicId: string;
        sequenceNumber: number;
        consensusTimestamp: string | null;
        coverageComplete: boolean;
    };
}

export type CurrentnessFailureCode =
    | 'INVALID_REQUEST'
    | 'AUTHENTICATION_FAILURE'
    | 'CAPABILITY_ABSENT'
    | 'TIMEOUT'
    | 'TRANSPORT_OUTAGE';

export interface CurrentnessFailureResponse {
    responseVersion: 'v1';
    status: 'error';
    code: CurrentnessFailureCode;
    message: string;
}
