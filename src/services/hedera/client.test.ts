import { fetchMirrorJson, MirrorNodeHttpError } from './client';

jest.mock('../../config', () => ({
    config: {
        MIRROR_NODE_URL: 'https://mirror.example/api/v1',
        MIRROR_NODE_AUTH_TYPE: 'none',
        MIRROR_NODE_AUTH_TOKEN: undefined,
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
});
