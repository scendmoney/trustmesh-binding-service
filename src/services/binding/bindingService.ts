import { config } from '../../config';
import { log } from '../../util/log';
import { BindRequest, BindingEvent } from './types';
import { submitToTopic } from '../hedera/client';
import { ethers } from 'ethers';

export class BindingService {

    private static async verifyProof(req: BindRequest): Promise<boolean> {
        const { proof, evmAddress } = req;

        try {
            if (proof.type === 'otp_attestation') {
                const secret = config.BINDING_SHARED_SECRET;
                if (!secret) {
                    log.warn('Binding shared secret not configured');
                    return false;
                }
                return proof.value === secret;
            }

            if (proof.type === 'magic_jwt') {
                if (config.MAGIC_JWT_ENABLED !== 'true') {
                    throw new Error('magic_jwt proof type is disabled');
                }
                // For v0, we assume the JWT is validated by an upstream gateway or passed as a trusted token.
                // In a real implementation, we would use Magic Admin SDK to validate.
                // If MAGIC_PUBLIC_KEY is set, we could do basic signature verification.
                // For Hackathon speed, if BINDING_SHARED_SECRET is present, we treat it as a trusted call wrapper,
                // OR we implement a placeholder check.

                // Placeholder: Fail if no value
                return !!proof.value && proof.value.length > 20;
            }

            if (proof.type === 'sig') {
                // Expected payload: "Bind <EVM> to <Hedera> on <WorldId>"
                // This canonical string must match what the client signed.
                const message = `Bind ${req.evmAddress} to ${req.hederaAccountId} on ${req.worldId}`;
                const recovered = ethers.verifyMessage(message, proof.value);
                return recovered.toLowerCase() === evmAddress.toLowerCase();
            }

            return false;
        } catch (error) {
            log.error('Proof verification failed', error);
            return false;
        }
    }

    static async bind(req: BindRequest) {
        // 1. Verify Proof
        const isValid = await this.verifyProof(req);
        if (!isValid) {
            throw new Error('Invalid proof');
        }

        // 2. Construct Canonical Event
        const event: BindingEvent = {
            type: 'IDENTITY_BINDING',
            worldId: req.worldId,
            evmAddress: req.evmAddress,
            hederaAccountId: req.hederaAccountId,
            createdAt: Date.now(),
            proofType: req.proof.type
        };

        // Calculate hash of the payload for integrity
        const payloadStr = JSON.stringify(event);
        event.payloadHash = ethers.sha256(ethers.toUtf8Bytes(payloadStr));

        // 3. Submit to HCS
        const result = await submitToTopic(config.IDENTITY_TOPIC_ID, JSON.stringify(event));

        log.info('Binding submitted', {
            worldId: req.worldId,
            evm: req.evmAddress,
            txId: result.transactionId
        });

        return {
            ok: true,
            bindingEventId: `${config.IDENTITY_TOPIC_ID}:${result.topicSequenceNumber}`,
            worldId: req.worldId,
            evmAddress: req.evmAddress,
            hederaAccountId: req.hederaAccountId
        };
    }
}
