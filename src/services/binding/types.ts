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
