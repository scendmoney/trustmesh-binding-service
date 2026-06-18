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

const buildMirrorHeaders = (): HeadersInit => {
    if (!config.MIRROR_NODE_AUTH_TOKEN || config.MIRROR_NODE_AUTH_TYPE === 'none') {
        return {};
    }

    if (config.MIRROR_NODE_AUTH_TYPE === 'bearer') {
        return {
            Authorization: `Bearer ${config.MIRROR_NODE_AUTH_TOKEN}`
        };
    }

    return {
        'x-api-key': config.MIRROR_NODE_AUTH_TOKEN
    };
};

const toMirrorUrl = (pathOrUrl: string): string => {
    if (/^https?:\/\//i.test(pathOrUrl)) {
        return pathOrUrl;
    }

    const baseUrl = config.MIRROR_NODE_URL.endsWith('/')
        ? config.MIRROR_NODE_URL
        : `${config.MIRROR_NODE_URL}/`;

    return new URL(pathOrUrl.replace(/^\//, ''), baseUrl).toString();
};

export const fetchMirrorJson = async <T>(pathOrUrl: string): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MIRROR_NODE_TIMEOUT_MS);

    try {
        const response = await fetch(toMirrorUrl(pathOrUrl), {
            headers: buildMirrorHeaders(),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Mirror node returned ${response.status}`);
        }

        return await response.json() as T;
    } finally {
        clearTimeout(timeout);
    }
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
        const directPayload = await fetchMirrorJson<{ account?: string }>(`/accounts/${encodeURIComponent(normalized)}`)
            .catch(() => null);

        if (directPayload?.account) {
            return directPayload.account;
        }

        const queryPayload = await fetchMirrorJson<{
            accounts?: Array<{ account?: string }>;
        }>(`/accounts?account.id=${encodeURIComponent(normalized)}`).catch(() => null);

        return queryPayload?.accounts?.[0]?.account ?? null;
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
