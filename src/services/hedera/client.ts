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

export type MirrorNodeRequestPolicyCode =
    | 'MIRROR_CONFIG_INVALID'
    | 'MIRROR_URL_INVALID'
    | 'MIRROR_ORIGIN_MISMATCH'
    | 'MIRROR_PATH_MISMATCH'
    | 'MIRROR_TOPIC_MISMATCH';

export class MirrorNodeRequestPolicyError extends Error {
    constructor(public readonly code: MirrorNodeRequestPolicyCode, message: string) {
        super(message);
        this.name = 'MirrorNodeRequestPolicyError';
    }
}

const mirrorBase = (): URL => {
    let base: URL;
    try {
        base = new URL(config.MIRROR_NODE_URL);
    } catch {
        throw new MirrorNodeRequestPolicyError('MIRROR_CONFIG_INVALID', 'Mirror base URL is invalid.');
    }
    if (
        (base.protocol !== 'https:' && base.protocol !== 'http:') ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new MirrorNodeRequestPolicyError(
            'MIRROR_CONFIG_INVALID',
            'Mirror base URL must be an HTTP(S) API base without credentials, query, or fragment.'
        );
    }
    base.pathname = base.pathname.replace(/\/+$/, '');
    return base;
};

const toMirrorUrl = (pathOrUrl: string): URL => {
    const base = mirrorBase();
    const basePath = base.pathname === '/' ? '' : base.pathname;
    let candidate: URL;
    try {
        if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('//')) {
            candidate = new URL(pathOrUrl, base.origin);
        } else if (basePath && pathOrUrl.startsWith(`${basePath}/`)) {
            candidate = new URL(pathOrUrl, base.origin);
        } else {
            const relative = pathOrUrl.replace(/^\//, '');
            candidate = new URL(`${basePath}/${relative}`, base.origin);
        }
    } catch {
        throw new MirrorNodeRequestPolicyError('MIRROR_URL_INVALID', 'Mirror request URL is malformed.');
    }

    if (candidate.origin !== base.origin || candidate.username || candidate.password) {
        throw new MirrorNodeRequestPolicyError('MIRROR_ORIGIN_MISMATCH', 'Mirror request origin does not match configured origin.');
    }
    if (basePath && candidate.pathname !== basePath && !candidate.pathname.startsWith(`${basePath}/`)) {
        throw new MirrorNodeRequestPolicyError('MIRROR_PATH_MISMATCH', 'Mirror request path is outside the configured API base path.');
    }
    candidate.hash = '';
    return candidate;
};

export class MirrorNodeHttpError extends Error {
    constructor(public readonly status: number) {
        super(`Mirror node returned ${status}`);
        this.name = 'MirrorNodeHttpError';
    }
}

const fetchMirrorUrlJson = async <T>(url: URL): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MIRROR_NODE_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: buildMirrorHeaders(),
            signal: controller.signal,
            redirect: 'error'
        });

        if (!response.ok) {
            throw new MirrorNodeHttpError(response.status);
        }

        return await response.json() as T;
    } finally {
        clearTimeout(timeout);
    }
};

export const fetchMirrorJson = async <T>(pathOrUrl: string): Promise<T> =>
    fetchMirrorUrlJson<T>(toMirrorUrl(pathOrUrl));

export const fetchMirrorTopicMessagesJson = async <T>(
    pathOrUrl: string,
    expectedTopicId: string
): Promise<T> => {
    if (!/^\d+\.\d+\.\d+$/.test(expectedTopicId)) {
        throw new MirrorNodeRequestPolicyError('MIRROR_CONFIG_INVALID', 'Configured Mirror topic ID is invalid.');
    }
    const base = mirrorBase();
    const basePath = base.pathname === '/' ? '' : base.pathname;
    const url = toMirrorUrl(pathOrUrl);
    const expectedPath = `${basePath}/topics/${encodeURIComponent(expectedTopicId)}/messages`;
    if (url.pathname !== expectedPath) {
        const topicPrefix = `${basePath}/topics/`;
        const expectedTopicPrefix = `${basePath}/topics/${encodeURIComponent(expectedTopicId)}/`;
        throw new MirrorNodeRequestPolicyError(
            url.pathname.startsWith(expectedTopicPrefix)
                ? 'MIRROR_PATH_MISMATCH'
                : url.pathname.startsWith(topicPrefix)
                    ? 'MIRROR_TOPIC_MISMATCH'
                    : 'MIRROR_PATH_MISMATCH',
            'Mirror pagination URL does not match the configured topic messages path.'
        );
    }
    return fetchMirrorUrlJson<T>(url);
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
