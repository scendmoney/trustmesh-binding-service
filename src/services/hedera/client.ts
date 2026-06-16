import { AccountId, Client, Hbar, PrivateKey, TopicMessageSubmitTransaction, TransferTransaction } from '@hashgraph/sdk';
import { config } from '../../config';
import { log } from '../../util/log';

let client: Client | null = null;

const parseOperatorKey = (value: string): PrivateKey => {
    const trimmed = value.trim();

    if (trimmed.startsWith('0x')) {
        return PrivateKey.fromStringECDSA(trimmed.slice(2));
    }

    if (trimmed.length > 64) {
        return PrivateKey.fromStringDer(trimmed);
    }

    return PrivateKey.fromString(trimmed);
};

export const getHederaClient = (): Client => {
    if (client) return client;

    try {
        client = Client.forName(config.HEDERA_NETWORK);
        client.setOperator(config.HEDERA_OPERATOR_ID, parseOperatorKey(config.HEDERA_OPERATOR_KEY));
        return client;
    } catch (error) {
        log.error('Failed to initialize Hedera client', error);
        throw error;
    }
};

export const submitToTopic = async (topicId: string, message: string) => {
    const hederaClient = getHederaClient();

    try {
        const tx = await new TopicMessageSubmitTransaction()
            .setTopicId(topicId)
            .setMessage(message)
            .execute(hederaClient);

        const receipt = await tx.getReceipt(hederaClient);
        const topicSequenceNumber = receipt.topicSequenceNumber?.toString() ?? null;

        return {
            status: 'SUCCESS',
            transactionId: tx.transactionId.toString(),
            topicSequenceNumber,
            sequenceNumber: topicSequenceNumber,
            consensusTimestamp: tx.transactionId.validStart?.toString?.() ?? null,
        };
    } catch (error) {
        log.error('Failed to submit to topic', error, { topicId });
        throw error;
    }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const lookupAccountByEvm = async (evmAddress: string): Promise<string | null> => {
    const normalized = evmAddress.trim().toLowerCase();

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.MIRROR_NODE_TIMEOUT_MS);

        try {
            const response = await fetch(
                `${config.MIRROR_NODE_URL}/accounts?account.id=${normalized}`,
                { signal: controller.signal }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json() as {
                accounts?: Array<{ account?: string }>;
            };

            return payload.accounts?.[0]?.account ?? null;
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        log.warn('Mirror lookup failed', {
            evmAddress: normalized,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
};

export const provisionAccountForEvmAlias = async (
    evmAddress: string
): Promise<{ hederaAccountId: string; transactionId: string }> => {
    const hederaClient = getHederaClient();
    const normalized = evmAddress.trim().toLowerCase();
    const operatorAccountId = AccountId.fromString(config.HEDERA_OPERATOR_ID);
    const aliasAccountId = AccountId.fromEvmAddress(0, 0, normalized);

    const tx = await new TransferTransaction()
        .addHbarTransfer(operatorAccountId, Hbar.fromTinybars(-1))
        .addHbarTransfer(aliasAccountId, Hbar.fromTinybars(1))
        .execute(hederaClient);

    await tx.getReceipt(hederaClient);

    for (let attempt = 0; attempt < config.HEDERA_ALIAS_POLL_ATTEMPTS; attempt++) {
        await delay(config.HEDERA_ALIAS_POLL_DELAY_MS);
        const resolved = await lookupAccountByEvm(normalized);
        if (resolved) {
            return {
                hederaAccountId: resolved,
                transactionId: tx.transactionId.toString()
            };
        }
    }

    throw new Error(`Timed out waiting for Hedera account creation for ${normalized}.`);
};
