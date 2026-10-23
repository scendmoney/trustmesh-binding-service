import {
    fetchMirrorJson,
    fetchMirrorTopicMessagesJson,
    MirrorNodeHttpError,
    MirrorNodeRequestPolicyError
} from './client';
import { config } from '../../config';

jest.mock('../../config', () => ({
    config: {
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

    it.each([401, 403, 404, 400, 503])(
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

    it('allows same-origin pagination on the exact configured topic path', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ messages: [] })
        });

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
