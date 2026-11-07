import {
    fetchMirrorJson,
    fetchMirrorTopicMessagesJson,
    MIRROR_MAX_RESPONSE_BYTES,
    MirrorNodeHttpError,
    MirrorNodeRequestPolicyError
} from './client';
import { config } from '../../config';

jest.mock('../../config', () => ({
    config: {
        NODE_ENV: 'test',
        MIRROR_NODE_URL: 'https://mirror.example/api/v1',
        MIRROR_NODE_AUTH_TYPE: 'bearer',
        MIRROR_NODE_AUTH_TOKEN: 'mirror-secret',
        MIRROR_NODE_TIMEOUT_MS: 1000
    }
}));

jest.mock('../../util/log', () => ({
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));

describe('fetchMirrorJson status preservation', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    it.each([401, 403, 404, 400, 429, 503])(
        'preserves Mirror HTTP status %s for policy classification',
        async status => {
            (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status });

            await expect(fetchMirrorJson('/topics/0.0.999/messages')).rejects.toEqual(
                expect.objectContaining<Partial<MirrorNodeHttpError>>({
                    name: 'MirrorNodeHttpError',
                    status
                })
            );
        }
    );

    it('preserves a numeric Retry-After value for bounded rate-limit recovery', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '2' })
        });

        await expect(fetchMirrorJson('/topics/0.0.999/messages')).rejects.toEqual(
            expect.objectContaining<Partial<MirrorNodeHttpError>>({
                name: 'MirrorNodeHttpError',
                status: 429,
                retryAfterMs: 2000
            })
        );
    });

    it('allows same-origin pagination on the exact configured topic path', async () => {
        (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ messages: [] })));

        await fetchMirrorTopicMessagesJson(
            'https://mirror.example/api/v1/topics/0.0.999/messages?limit=100&order=desc',
            '0.0.999'
        );

        expect(global.fetch).toHaveBeenCalledWith(
            expect.objectContaining({
                origin: 'https://mirror.example',
                pathname: '/api/v1/topics/0.0.999/messages'
            }),
            expect.objectContaining({
                headers: { Authorization: 'Bearer mirror-secret' },
                redirect: 'error'
            })
        );
    });

    it('allows credential-free HTTP only for explicit localhost test fixtures', async () => {
        const previous = {
            url: config.MIRROR_NODE_URL,
            nodeEnv: config.NODE_ENV,
            authType: config.MIRROR_NODE_AUTH_TYPE,
            authToken: config.MIRROR_NODE_AUTH_TOKEN
        };
        config.MIRROR_NODE_URL = 'http://localhost:8080/api/v1';
        config.NODE_ENV = 'test';
        config.MIRROR_NODE_AUTH_TYPE = 'none';
        config.MIRROR_NODE_AUTH_TOKEN = undefined;
        (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ messages: [] })));

        try {
            await fetchMirrorTopicMessagesJson('/topics/0.0.999/messages?limit=100', '0.0.999');

            expect(global.fetch).toHaveBeenCalledWith(
                expect.objectContaining({ origin: 'http://localhost:8080' }),
                expect.objectContaining({ redirect: 'error', headers: {} })
            );
        } finally {
            config.MIRROR_NODE_URL = previous.url;
            config.NODE_ENV = previous.nodeEnv;
            config.MIRROR_NODE_AUTH_TYPE = previous.authType;
            config.MIRROR_NODE_AUTH_TOKEN = previous.authToken;
        }
    });

    it.each([
        ['non-local HTTP test URL', 'http://mirror.example/api/v1', 'test', 'none', undefined],
        ['localhost HTTP production URL', 'http://localhost/api/v1', 'production', 'none', undefined],
        ['localhost HTTP with credentials', 'http://localhost/api/v1', 'test', 'bearer', 'mirror-secret']
    ] as const)('rejects %s before transport', async (_label, url, nodeEnv, authType, authToken) => {
        const previous = {
            url: config.MIRROR_NODE_URL,
            nodeEnv: config.NODE_ENV,
            authType: config.MIRROR_NODE_AUTH_TYPE,
            authToken: config.MIRROR_NODE_AUTH_TOKEN
        };
        config.MIRROR_NODE_URL = url;
        config.NODE_ENV = nodeEnv;
        config.MIRROR_NODE_AUTH_TYPE = authType;
        config.MIRROR_NODE_AUTH_TOKEN = authToken;

        try {
            await expect(fetchMirrorTopicMessagesJson('/topics/0.0.999/messages', '0.0.999')).rejects.toEqual(
                expect.objectContaining<Partial<MirrorNodeRequestPolicyError>>({ code: 'MIRROR_CONFIG_INVALID' })
            );
            expect(global.fetch).not.toHaveBeenCalled();
        } finally {
            config.MIRROR_NODE_URL = previous.url;
            config.NODE_ENV = previous.nodeEnv;
            config.MIRROR_NODE_AUTH_TYPE = previous.authType;
            config.MIRROR_NODE_AUTH_TOKEN = previous.authToken;
        }
    });

    it('bounds each Mirror response body before parsing JSON', async () => {
        (global.fetch as jest.Mock).mockResolvedValue(new Response('{"messages":[]}'));

        await expect(fetchMirrorTopicMessagesJson(
            '/topics/0.0.999/messages',
            '0.0.999',
            { maxResponseBytes: 4 }
        )).rejects.toEqual(
            expect.objectContaining<Partial<MirrorNodeRequestPolicyError>>({
                code: 'MIRROR_RESPONSE_TOO_LARGE'
            })
        );
    });

    it('does not allow callers to raise the Mirror response hard limit', async () => {
        await expect(fetchMirrorTopicMessagesJson(
            '/topics/0.0.999/messages',
            '0.0.999',
            { maxResponseBytes: MIRROR_MAX_RESPONSE_BYTES + 1 }
        )).rejects.toEqual(
            expect.objectContaining<Partial<MirrorNodeRequestPolicyError>>({ code: 'MIRROR_CONFIG_INVALID' })
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([
        [
            'cross-origin',
            'https://attacker.example/api/v1/topics/0.0.999/messages?limit=100',
            'MIRROR_ORIGIN_MISMATCH'
        ],
        [
            'cross-topic',
            'https://mirror.example/api/v1/topics/0.0.998/messages?limit=100',
            'MIRROR_TOPIC_MISMATCH'
        ],
        [
            'wrong-path',
            'https://mirror.example/api/v1/topics/0.0.999/transactions?limit=100',
            'MIRROR_PATH_MISMATCH'
        ],
        [
            'malformed-url',
            'http://[invalid',
            'MIRROR_URL_INVALID'
        ]
    ])('rejects %s pagination before credentials can be sent', async (_label, url, code) => {
        await expect(fetchMirrorTopicMessagesJson(url, '0.0.999')).rejects.toEqual(
            expect.objectContaining<Partial<MirrorNodeRequestPolicyError>>({
                code: code as MirrorNodeRequestPolicyError['code']
            })
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects malformed Mirror base configuration before transport', async () => {
        const previous = config.MIRROR_NODE_URL;
        config.MIRROR_NODE_URL = 'not a URL';
        try {
            await expect(fetchMirrorTopicMessagesJson('/topics/0.0.999/messages', '0.0.999')).rejects.toEqual(
                expect.objectContaining<Partial<MirrorNodeRequestPolicyError>>({
                    code: 'MIRROR_CONFIG_INVALID'
                })
            );
            expect(global.fetch).not.toHaveBeenCalled();
        } finally {
            config.MIRROR_NODE_URL = previous;
        }
    });
});
