
import { ResolveService } from './resolveService';
import { config } from '../../config';

// Mock config
jest.mock('../../config', () => ({
    config: {
        MIRROR_NODE_URL: 'https://test.mirror.hedera.com',
        IDENTITY_TOPIC_ID: '0.0.999',
        RESOLVE_MAX_PAGES: 3,
        MAGIC_JWT_ENABLED: 'false'
    }
}));

// Mock Log
jest.mock('../../util/log', () => ({
    log: {
        error: jest.fn(),
        info: jest.fn()
    }
}));

// Mock global fetch
global.fetch = jest.fn();

describe('ResolveService Pagination', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Clear cache hack: access private static map if possible, but easier to use different keys
    });

    const mockMessage = (worldId: string, evm: string, seq: number) => {
        const event = {
            type: 'IDENTITY_BINDING',
            worldId,
            evmAddress: evm,
            hederaAccountId: `0.0.${seq}`,
            createdAt: 1000 + seq,
            proofType: 'sig'
        };
        return {
            consensus_timestamp: `${1000 + seq}.000`,
            topic_id: '0.0.999',
            sequence_number: seq,
            message: Buffer.from(JSON.stringify(event)).toString('base64')
        };
    };

    it('should paginate to find a binding on the second page', async () => {
        const targetEvm = '0x123';
        const targetWorld = 'world-1';

        // Page 1: Empty or irrelevant
        const page1 = {
            messages: [mockMessage('other', '0x999', 10)],
            links: { next: '/next-link-page-2' }
        };

        // Page 2: Contains the target
        const page2 = {
            messages: [mockMessage(targetWorld, targetEvm, 5)],
            links: { next: '/next-link-page-3' }
        };

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(page1)
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(page2)
            });

        const result = await ResolveService.resolve(targetWorld, targetEvm);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result.evm).toBe(targetEvm);
        expect(result.worldId).toBe(targetWorld);
        expect(result.hederaAccountId).toBe('0.0.5');
        expect(result.bindingEventId).toBe('0.0.999:5');
    });

    it('should stop after max pages if not found', async () => {
        const page = {
            messages: [mockMessage('other', '0x999', 10)],
            links: { next: '/next' }
        };

        // Always return irrelevant data
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(page)
        });

        const result = await ResolveService.resolve('missing', '0x000');

        // Config limit is 3, so we expect 3 calls
        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(result.hederaAccountId).toBeNull();
    });
});
