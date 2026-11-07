import { AccountId, Client, Hbar, PrivateKey, TopicMessageSubmitTransaction, TransferTransaction } from '@hashgraph/sdk';
import { hashMessage, SigningKey } from 'ethers';
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
    | 'MIRROR_TOPIC_MISMATCH'
    | 'MIRROR_RESPONSE_TOO_LARGE';

export const MIRROR_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface MirrorTopicMessageFetchOptions {
    maxResponseBytes?: number;
    onResponseBytes?: (bytes: number) => void;
}

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
    const credentialsConfigured = config.MIRROR_NODE_AUTH_TYPE !== 'none' ||
        Boolean(config.MIRROR_NODE_AUTH_TOKEN);
    const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]']
        .includes(base.hostname.toLowerCase());
    const allowHttpFixture = config.NODE_ENV === 'test' && isLoopbackHost && !credentialsConfigured;
    if (
        (base.protocol !== 'https:' && !(base.protocol === 'http:' && allowHttpFixture)) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new MirrorNodeRequestPolicyError(
            'MIRROR_CONFIG_INVALID',
            'Mirror base URL must use HTTPS, except for credential-free localhost test fixtures, and must not include credentials, query, or fragment.'
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
    constructor(public readonly status: number, public readonly retryAfterMs?: number) {
        super(`Mirror node returned ${status}`);
        this.name = 'MirrorNodeHttpError';
    }
}

const parseRetryAfterMs = (value: string | null | undefined): number | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) {
        const seconds = Number(normalized);
        if (Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
            return seconds * 1000;
        }
        return undefined;
    }

    const retryAt = Date.parse(normalized);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
};

const MIRROR_MAX_429_RETRIES = 2;
const MIRROR_MIN_RETRY_WAIT_MS = 1000;
const MIRROR_MAX_RETRY_AFTER_MS = 5000;
const MIRROR_MAX_TOTAL_RETRY_WAIT_MS = 10000;

const delayMirrorRetry = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export type EvmAliasReconciliation =
    | { status: 'resolved'; hederaAccountId: string }
    | { status: 'absent' }
    | { status: 'unknown' };

export const reconcileEvmAlias = async (evmAddress: string): Promise<EvmAliasReconciliation> => {
    try {
        const result = await fetchMirrorJson<{ account?: unknown }>(
            `/accounts/${encodeURIComponent(evmAddress.toLowerCase())}`
        );
        if (typeof result.account === 'string' && /^0\.0\.\d+$/.test(result.account)) {
            return { status: 'resolved', hederaAccountId: result.account };
        }
        return { status: 'unknown' };
    } catch (error) {
        if (error instanceof MirrorNodeHttpError && error.status === 404) {
            return { status: 'absent' };
        }
        return { status: 'unknown' };
    }
};

export interface HederaOperatorEvidenceSigner {
    accountId: string;
    publicKey: string;
    signMessage(message: string): string;
}

export const getHederaOperatorEvidenceSigner = (): HederaOperatorEvidenceSigner => {
    try {
        const operatorKey = parseOperatorKey(config.HEDERA_OPERATOR_KEY);
        if (PrivateKey.getAlgorithm(operatorKey.toStringDer()) !== 'ecdsa') {
            throw new Error('Binding evidence requires an ECDSA Hedera operator.');
        }
        const rawPrivateKey = operatorKey.toStringRaw();
        const signingKey = new SigningKey(rawPrivateKey.startsWith('0x') ? rawPrivateKey : `0x${rawPrivateKey}`);
        const operatorPublicKey = operatorKey.publicKey.toStringRaw();
        if (
            SigningKey.computePublicKey(`0x${operatorPublicKey.replace(/^0x/, '')}`, false) !==
            SigningKey.computePublicKey(signingKey.publicKey, false)
        ) {
            throw new Error('EIP-191 signer does not match the Hedera operator key.');
        }
        return {
            accountId: AccountId.fromString(config.HEDERA_OPERATOR_ID).toString(),
            publicKey: signingKey.publicKey,
            signMessage: message => signingKey.sign(hashMessage(message)).serialized
        };
    } catch {
        throw new Error('The configured Hedera operator cannot sign EIP-191 binding evidence.');
    }
};

const readResponseBytes = async (response: Response, maxResponseBytes: number): Promise<Buffer> => {
    const responseHeaders = (response as Response & { headers?: Headers }).headers;
    const contentLength = responseHeaders?.get?.('content-length');
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
        throw new MirrorNodeRequestPolicyError(
            'MIRROR_RESPONSE_TOO_LARGE',
            'Mirror response exceeded the configured read limit.'
        );
    }

    const reader = response.body?.getReader();
    if (!reader) {
        const responseLike = response as Response & { json?: () => Promise<unknown> };
        const rawBody = typeof response.text === 'function'
            ? await response.text()
            : JSON.stringify(await responseLike.json?.());
        const body = Buffer.from(rawBody ?? '', 'utf8');
        if (body.byteLength > maxResponseBytes) {
            throw new MirrorNodeRequestPolicyError(
                'MIRROR_RESPONSE_TOO_LARGE',
                'Mirror response exceeded the configured read limit.'
            );
        }
        return body;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
            try {
                await reader.cancel();
            } catch {
                // Preserve the typed size-limit failure if cancellation also fails.
            }
            throw new MirrorNodeRequestPolicyError(
                'MIRROR_RESPONSE_TOO_LARGE',
                'Mirror response exceeded the configured read limit.'
            );
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
};

const fetchMirrorUrlJsonOnce = async <T>(
    url: URL,
    options: MirrorTopicMessageFetchOptions = {}
): Promise<T> => {
    const maxResponseBytes = options.maxResponseBytes ?? MIRROR_MAX_RESPONSE_BYTES;
    if (
        !Number.isSafeInteger(maxResponseBytes) ||
        maxResponseBytes <= 0 ||
        maxResponseBytes > MIRROR_MAX_RESPONSE_BYTES
    ) {
        throw new MirrorNodeRequestPolicyError('MIRROR_CONFIG_INVALID', 'Mirror response limit is invalid.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MIRROR_NODE_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: buildMirrorHeaders(),
            signal: controller.signal,
            redirect: 'error'
        });

        if (!response.ok) {
            const retryAfter = response.headers?.get?.('retry-after');
            throw new MirrorNodeHttpError(
                response.status,
                response.status === 429 ? parseRetryAfterMs(retryAfter) : undefined
            );
        }

        const body = await readResponseBytes(response, maxResponseBytes);
        options.onResponseBytes?.(body.byteLength);
        return JSON.parse(body.toString('utf8')) as T;
    } finally {
        clearTimeout(timeout);
    }
};

const fetchMirrorUrlJson = async <T>(
    url: URL,
    options: MirrorTopicMessageFetchOptions = {}
): Promise<T> => {
    let retries = 0;
    let totalRetryWaitMs = 0;

    while (true) {
        try {
            return await fetchMirrorUrlJsonOnce<T>(url, options);
        } catch (error) {
            if (!(error instanceof MirrorNodeHttpError) || error.status !== 429 || retries >= MIRROR_MAX_429_RETRIES) {
                throw error;
            }

            const retryWaitMs = Math.max(
                MIRROR_MIN_RETRY_WAIT_MS,
                Number.isFinite(error.retryAfterMs) && error.retryAfterMs! >= 0
                    ? Math.ceil(error.retryAfterMs!)
                    : MIRROR_MIN_RETRY_WAIT_MS
            );
            if (
                retryWaitMs > MIRROR_MAX_RETRY_AFTER_MS ||
                totalRetryWaitMs + retryWaitMs > MIRROR_MAX_TOTAL_RETRY_WAIT_MS
            ) {
                throw error;
            }

            retries++;
            totalRetryWaitMs += retryWaitMs;
            await delayMirrorRetry(retryWaitMs);
        }
    }
};

export const fetchMirrorJson = async <T>(pathOrUrl: string): Promise<T> =>
    fetchMirrorUrlJson<T>(toMirrorUrl(pathOrUrl));

export const fetchMirrorTopicMessagesJson = async <T>(
    pathOrUrl: string,
    expectedTopicId: string,
    options: MirrorTopicMessageFetchOptions = {}
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
    return fetchMirrorUrlJson<T>(url, options);
};

export type HederaFailureClassification =
    | 'HEDERA_INITIALIZATION_ERROR'
    | 'HEDERA_SUBMISSION_ERROR'
    | 'HEDERA_NETWORK_ERROR'
    | 'HEDERA_TIMEOUT';

export const classifyHederaFailure = (
    error: unknown,
    phase: 'initialization' | 'submission'
): HederaFailureClassification => {
    if (error instanceof Error && error.name === 'AbortError') return 'HEDERA_TIMEOUT';
    if (phase === 'submission' && error instanceof TypeError) return 'HEDERA_NETWORK_ERROR';
    return phase === 'initialization' ? 'HEDERA_INITIALIZATION_ERROR' : 'HEDERA_SUBMISSION_ERROR';
};

export const getHederaClient = (): Client => {
    if (client) return client;

    let initializedClient: Client | null = null;
    try {
        initializedClient = Client.forName(config.HEDERA_NETWORK);
        initializedClient.setOperator(config.HEDERA_OPERATOR_ID, parseOperatorKey(config.HEDERA_OPERATOR_KEY));
        client = initializedClient;
        return initializedClient;
    } catch (error) {
        try {
            initializedClient?.close();
        } catch {
            // Initialization still fails closed if local client cleanup also fails.
        }
        log.error('Failed to initialize Hedera client', undefined, {
            classification: classifyHederaFailure(error, 'initialization')
        });
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
        log.error('Failed to submit to topic', undefined, {
            classification: classifyHederaFailure(error, 'submission')
        });
        throw error;
    }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const classifyMirrorLookupFailure = (error: unknown): string => {
    if (error instanceof MirrorNodeRequestPolicyError) return error.code;
    if (error instanceof MirrorNodeHttpError) {
        return Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
            ? `MIRROR_HTTP_${error.status}`
            : 'MIRROR_HTTP_ERROR';
    }
    if (error instanceof Error && error.name === 'AbortError') return 'MIRROR_TIMEOUT';
    if (error instanceof TypeError) return 'MIRROR_NETWORK_ERROR';
    return 'MIRROR_LOOKUP_ERROR';
};

export const lookupAccountByEvm = async (evmAddress: string): Promise<string | null> => {
    const normalized = evmAddress.trim().toLowerCase();

    const directPayload = await fetchMirrorJson<{ account?: string }>(`/accounts/${encodeURIComponent(normalized)}`)
        .catch(() => null);

    if (directPayload?.account) {
        return directPayload.account;
    }

    try {
        const queryPayload = await fetchMirrorJson<{
            accounts?: Array<{ account?: string }>;
        }>(`/accounts?account.id=${encodeURIComponent(normalized)}`);

        return queryPayload?.accounts?.[0]?.account ?? null;
    } catch (error) {
        log.warn('Mirror EVM account lookup failed', {
            classification: classifyMirrorLookupFailure(error)
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
