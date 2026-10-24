import { AccountId } from '@hashgraph/sdk';
import { SigningKey } from 'ethers';
import packageJson from '../../../package.json';
import { config } from '../../config';
import {
    canonicalEvidencePayload,
    CurrentnessReadError,
    CurrentnessService
} from './currentnessService';
import {
    getHederaOperatorEvidenceSigner,
    provisionAccountForEvmAlias,
    reconcileEvmAlias,
    submitToTopic
} from '../hedera/client';
import type {
    CurrentnessResponse,
    IdentityRegistrationBindingEnvelopeV1,
    IdentityRegistrationBlockedResponseV1,
    IdentityRegistrationPendingResponseV1,
    IdentityRegistrationRequestV1,
    IdentityRegistrationResponseV1
} from './types';

const SERVICE_VERSION = packageJson.version;
const IDENTITY_PURPOSE = 'eugene.business.admin.custody' as const;

type AuthorityCheck =
    | { ok: true; signer: ReturnType<typeof getHederaOperatorEvidenceSigner> }
    | { ok: false; response: IdentityRegistrationBlockedResponseV1 };

type CurrentnessCheck =
    | { ok: true; currentness: CurrentnessResponse }
    | { ok: false; response: IdentityRegistrationPendingResponseV1 | IdentityRegistrationBlockedResponseV1 };

const blocked = (
    reason: IdentityRegistrationBlockedResponseV1['reason'],
    message: string
): IdentityRegistrationBlockedResponseV1 => ({
    responseVersion: 'v1',
    status: 'blocked',
    reason,
    retryable: false,
    message
});

const pending = (
    reason: IdentityRegistrationPendingResponseV1['reason'],
    message: string
): IdentityRegistrationPendingResponseV1 => ({
    responseVersion: 'v1',
    status: 'pending',
    reason,
    retryable: true,
    message
});

const exactIdentity = (input: IdentityRegistrationRequestV1) => ({
    canonicalDid: input.canonicalDid,
    stableIdentifier: input.stableIdentifier,
    issuer: input.issuer
});

const isTopicSequence = (value: string): boolean =>
    /^(?:[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));

const authorityCheck = (): AuthorityCheck => {
    if (
        !config.BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID ||
        !config.BINDING_EVIDENCE_AUTHORITY_KEY_ID ||
        !config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY ||
        !config.BINDING_EVIDENCE_AUTHORIZATION_BASIS
    ) {
        return {
            ok: false,
            response: blocked('INVALID_AUTHORITY_CONFIGURATION', 'Binding evidence authority is not fully configured.')
        };
    }

    try {
        const signer = getHederaOperatorEvidenceSigner();
        const authorityAccountId = AccountId.fromString(config.BINDING_EVIDENCE_AUTHORITY_ACCOUNT_ID).toString();
        const authorityPublicKey = SigningKey.computePublicKey(config.BINDING_EVIDENCE_AUTHORITY_PUBLIC_KEY, false);
        const signerPublicKey = SigningKey.computePublicKey(signer.publicKey, false);

        if (authorityAccountId !== signer.accountId || authorityPublicKey !== signerPublicKey) {
            return {
                ok: false,
                response: blocked(
                    'AUTHORITY_SIGNER_MISMATCH',
                    'Configured binding evidence authority does not match the Hedera operator signer.'
                )
            };
        }
        return { ok: true, signer };
    } catch {
        return {
            ok: false,
            response: blocked('INVALID_AUTHORITY_CONFIGURATION', 'Binding evidence authority configuration is invalid.')
        };
    }
};

const readCurrentness = async (input: IdentityRegistrationRequestV1): Promise<CurrentnessCheck> => {
    try {
        const currentness = await CurrentnessService.read({
            requestVersion: 'v1',
            identity: exactIdentity(input)
        });
        return { ok: true, currentness };
    } catch (error) {
        if (error instanceof CurrentnessReadError && ['TIMEOUT', 'TEMPORARY_OUTAGE'].includes(error.code)) {
            return {
                ok: false,
                response: pending('CURRENTNESS_TEMPORARILY_UNAVAILABLE', 'A fresh currentness read is temporarily unavailable.')
            };
        }
        return {
            ok: false,
            response: blocked('CURRENTNESS_UNAVAILABLE', 'A trustworthy currentness read could not be completed.')
        };
    }
};

const boundFromCurrentness = (
    input: IdentityRegistrationRequestV1,
    currentness: CurrentnessResponse
): IdentityRegistrationResponseV1 => {
    const binding = currentness.binding;
    if (
        currentness.disposition !== 'CURRENT' ||
        !binding ||
        binding.evmPublicAddress.toLowerCase() !== input.evmPublicAddress.toLowerCase()
    ) {
        return blocked(
            'IDENTITY_CONFLICT',
            'The current binding does not match the exact authenticated EVM address.'
        );
    }

    const prefix = `${config.IDENTITY_TOPIC_ID}:`;
    if (!binding.bindingEventId.startsWith(prefix)) {
        return blocked('CURRENTNESS_UNAVAILABLE', 'Current binding receipt is outside the configured identity topic.');
    }
    const sequenceNumber = binding.bindingEventId.slice(prefix.length);
    if (!isTopicSequence(sequenceNumber)) {
        return blocked('CURRENTNESS_UNAVAILABLE', 'Current binding receipt has an invalid topic sequence.');
    }

    return {
        responseVersion: 'v1',
        status: 'bound',
        identity: exactIdentity(input),
        evmPublicAddress: input.evmPublicAddress,
        hederaAccountId: binding.hederaAccountId,
        bindingEventReceipt: {
            topicId: config.IDENTITY_TOPIC_ID,
            sequenceNumber,
            bindingEventId: binding.bindingEventId,
            transactionId: null
        },
        resolutionSource: 'currentness-reconciled',
        serviceVersion: currentness.serviceVersion,
        boundAt: binding.sourceEventAt
    };
};

const createEvidence = (
    input: IdentityRegistrationRequestV1,
    hederaAccountId: string,
    resolutionSource: 'provider-existing' | 'provider-provisioned',
    signer: ReturnType<typeof getHederaOperatorEvidenceSigner>
): IdentityRegistrationBindingEnvelopeV1 => {
    const event: IdentityRegistrationBindingEnvelopeV1 = {
        t: resolutionSource === 'provider-existing' ? 'IDENTITY_ASSERT' : 'IDENTITY_BIND',
        v: 1,
        sub: input.canonicalDid,
        iat: new Date().toISOString(),
        chain: config.HEDERA_NETWORK,
        payload: {
            stable_identifier: input.stableIdentifier,
            issuer: input.issuer,
            evm_address: input.evmPublicAddress,
            hedera_account_id: hederaAccountId,
            resolution_source: resolutionSource,
            consent_receipt_ref: input.consentReceiptRef,
            requested_at: input.requestedAt
        },
        provenance: {
            schemaVersion: 1,
            authorityAccountId: signer.accountId,
            authorityKeyId: config.BINDING_EVIDENCE_AUTHORITY_KEY_ID!,
            authorizationBasis: config.BINDING_EVIDENCE_AUTHORIZATION_BASIS!,
            authorizationBasisVersion: 'v1',
            signatureAlgorithm: 'EIP191_SECP256K1',
            scope: {
                purpose: 'TRUSTMESH_IDENTITY_CURRENTNESS',
                network: config.HEDERA_NETWORK,
                topicId: config.IDENTITY_TOPIC_ID,
                schemaVersion: 1,
                normalizationVersion: 'exact-v1'
            },
            signature: ''
        }
    };
    event.provenance.signature = signer.signMessage(canonicalEvidencePayload(event));
    return event;
};

const boundFromSubmission = (
    input: IdentityRegistrationRequestV1,
    hederaAccountId: string,
    resolutionSource: 'provider-existing' | 'provider-provisioned',
    submitted: { sequenceNumber: string; transactionId: string },
    boundAt: string
): IdentityRegistrationResponseV1 => {
    if (!isTopicSequence(submitted.sequenceNumber) || !submitted.transactionId) {
        return pending('BINDING_SUBMISSION_UNCERTAIN', 'The binding submission did not return a complete attributable receipt.');
    }
    const bindingEventId = `${config.IDENTITY_TOPIC_ID}:${submitted.sequenceNumber}`;
    return {
        responseVersion: 'v1',
        status: 'bound',
        identity: exactIdentity(input),
        evmPublicAddress: input.evmPublicAddress,
        hederaAccountId,
        bindingEventReceipt: {
            topicId: config.IDENTITY_TOPIC_ID,
            sequenceNumber: submitted.sequenceNumber,
            bindingEventId,
            transactionId: submitted.transactionId
        },
        resolutionSource,
        serviceVersion: SERVICE_VERSION,
        boundAt
    };
};

const blockedOnNonCurrent = (disposition: string): IdentityRegistrationBlockedResponseV1 =>
    blocked('CURRENTNESS_NOT_CURRENT', `Identity registration is blocked by currentness disposition ${disposition}.`);

const reconcileAfterUncertainProvision = async (
    input: IdentityRegistrationRequestV1,
    signer: ReturnType<typeof getHederaOperatorEvidenceSigner>
): Promise<IdentityRegistrationResponseV1> => {
    const fresh = await readCurrentness(input);
    if (!fresh.ok) return fresh.response;
    if (fresh.currentness.disposition === 'CURRENT') {
        return boundFromCurrentness(input, fresh.currentness);
    }
    if (fresh.currentness.disposition !== 'UNBOUND') {
        return blockedOnNonCurrent(fresh.currentness.disposition);
    }

    const alias = await reconcileEvmAlias(input.evmPublicAddress);
    if (alias.status !== 'resolved') {
        return pending('PROVIDER_OUTCOME_UNCERTAIN', 'Provider completion remains uncertain; retry only after another fresh reconciliation.');
    }
    return publishBinding(input, alias.hederaAccountId, 'provider-existing', signer);
};

const reconcileAfterUncertainSubmission = async (
    input: IdentityRegistrationRequestV1
): Promise<IdentityRegistrationResponseV1> => {
    const fresh = await readCurrentness(input);
    if (!fresh.ok) {
        return pending('BINDING_SUBMISSION_UNCERTAIN', 'Binding submission outcome is uncertain and fresh reconciliation is unavailable.');
    }
    if (fresh.currentness.disposition === 'CURRENT') {
        return boundFromCurrentness(input, fresh.currentness);
    }
    if (fresh.currentness.disposition !== 'UNBOUND') {
        return blockedOnNonCurrent(fresh.currentness.disposition);
    }
    return pending('BINDING_SUBMISSION_UNCERTAIN', 'Binding submission is not yet visible in complete currentness history.');
};

const publishBinding = async (
    input: IdentityRegistrationRequestV1,
    hederaAccountId: string,
    resolutionSource: 'provider-existing' | 'provider-provisioned',
    signer: ReturnType<typeof getHederaOperatorEvidenceSigner>
): Promise<IdentityRegistrationResponseV1> => {
    const event = createEvidence(input, hederaAccountId, resolutionSource, signer);
    try {
        const receipt = await submitToTopic(config.IDENTITY_TOPIC_ID, JSON.stringify(event));
        const sequenceNumber = receipt.sequenceNumber ?? receipt.topicSequenceNumber;
        if (!sequenceNumber || !receipt.transactionId) {
            return await reconcileAfterUncertainSubmission(input);
        }
        return boundFromSubmission(
            input,
            hederaAccountId,
            resolutionSource,
            { sequenceNumber, transactionId: receipt.transactionId },
            event.iat
        );
    } catch {
        return reconcileAfterUncertainSubmission(input);
    }
};

const performRegistration = async (
    input: IdentityRegistrationRequestV1
): Promise<IdentityRegistrationResponseV1> => {
    const authority = authorityCheck();
    if (!authority.ok) return authority.response;

    const fresh = await readCurrentness(input);
    if (!fresh.ok) return fresh.response;
    if (fresh.currentness.disposition === 'CURRENT') {
        return boundFromCurrentness(input, fresh.currentness);
    }
    if (fresh.currentness.disposition !== 'UNBOUND') {
        return blockedOnNonCurrent(fresh.currentness.disposition);
    }

    const alias = await reconcileEvmAlias(input.evmPublicAddress);
    if (alias.status === 'unknown') {
        return pending('PROVIDER_OUTCOME_UNCERTAIN', 'Provider identity could not be reconciled safely.');
    }
    if (alias.status === 'resolved') {
        return publishBinding(input, alias.hederaAccountId, 'provider-existing', authority.signer);
    }

    try {
        const provisioned = await provisionAccountForEvmAlias(input.evmPublicAddress);
        return publishBinding(input, provisioned.hederaAccountId, 'provider-provisioned', authority.signer);
    } catch {
        return reconcileAfterUncertainProvision(input, authority.signer);
    }
};

const identityLocks = new Map<string, Promise<void>>();
const inFlightIdempotency = new Map<string, {
    fingerprint: string;
    operation: Promise<IdentityRegistrationResponseV1>;
}>();

const serializeByIdentity = async (
    input: IdentityRegistrationRequestV1,
    operation: () => Promise<IdentityRegistrationResponseV1>
): Promise<IdentityRegistrationResponseV1> => {
    const identityKey = JSON.stringify([input.canonicalDid, input.stableIdentifier, input.issuer]);
    const previous = identityLocks.get(identityKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    identityLocks.set(identityKey, tail);

    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (identityLocks.get(identityKey) === tail) identityLocks.delete(identityKey);
    }
};

export class IdentityRegistrationService {
    static async register(input: IdentityRegistrationRequestV1): Promise<IdentityRegistrationResponseV1> {
        if (input.purpose !== IDENTITY_PURPOSE) {
            return blocked('IDENTITY_CONFLICT', 'Identity registration purpose is not authorized.');
        }

        const fingerprint = JSON.stringify([
            input.requestVersion,
            input.canonicalDid,
            input.stableIdentifier,
            input.issuer,
            input.evmPublicAddress,
            input.purpose,
            input.consentReceiptRef,
            input.requestedAt
        ]);
        const prior = inFlightIdempotency.get(input.idempotencyKey);
        if (prior) {
            if (prior.fingerprint !== fingerprint) {
                return blocked('IDEMPOTENCY_KEY_REUSE', 'Idempotency key was reused with different registration input.');
            }
            return prior.operation;
        }

        const operation = serializeByIdentity(input, () => performRegistration(input))
            .catch(() => blocked('CURRENTNESS_UNAVAILABLE', 'Identity registration failed closed.'));
        inFlightIdempotency.set(input.idempotencyKey, { fingerprint, operation });
        try {
            return await operation;
        } finally {
            if (inFlightIdempotency.get(input.idempotencyKey)?.operation === operation) {
                inFlightIdempotency.delete(input.idempotencyKey);
            }
        }
    }
}
