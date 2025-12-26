import { config } from '../../config';
import { log } from '../../util/log';
import { ResolveResult, BindingEvent } from './types';
import { ethers } from 'ethers';

// Simple in-memory cache with TTL
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
interface CacheEntry {
    data: ResolveResult | null;
    timestamp: number;
}
const resolveCache = new Map<string, CacheEntry>();

export class ResolveService {
    private static async fetchMirrorMessages(topicId: string, limit = 50): Promise<any[]> {
        try {
            const url = `${config.MIRROR_NODE_URL}/topics/${topicId}/messages?limit=${limit}&order=desc`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Mirror node error: ${response.statusText}`);
            const data = await response.json();
            return data.messages || [];
        } catch (error) {
            log.error('Failed to fetch from mirror node', error);
            return [];
        }
    }

    private static decodeMessage(base64: string): BindingEvent | null {
        try {
            const json = Buffer.from(base64, 'base64').toString('utf-8');
            const event = JSON.parse(json);
            if (event.type === 'IDENTITY_BINDING') {
                return event as BindingEvent;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    static async resolve(worldId: string, evmAddress: string): Promise<ResolveResult> {
        const cacheKey = `${worldId}:${evmAddress.toLowerCase()}`;
        const cached = resolveCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.data!;
        }

        try {
            // Fetch recent messages from the configured Identity Topic
            // In production, an indexer is preferred. For v0, we scan recent history.
            const messages = await this.fetchMirrorMessages(config.IDENTITY_TOPIC_ID, 100);

            const normalizedEvm = evmAddress.toLowerCase();

            // Find latest valid binding for this worldId + EVM address
            const match = messages.find(msg => {
                const event = this.decodeMessage(msg.message);
                return event &&
                    event.worldId === worldId &&
                    event.evmAddress.toLowerCase() === normalizedEvm;
            });

            if (match) {
                const event = this.decodeMessage(match.message)!;
                const result: ResolveResult = {
                    worldId,
                    evm: evmAddress,
                    hederaAccountId: event.hederaAccountId,
                    bindingEventId: `${match.topic_id}:${match.sequence_number}`,
                    updatedAt: new Date(Number(match.consensus_timestamp.split('.')[0]) * 1000).getTime()
                };

                resolveCache.set(cacheKey, { data: result, timestamp: Date.now() });
                return result;
            }

            // Not found
            const empty: ResolveResult = {
                worldId,
                evm: evmAddress,
                hederaAccountId: null,
                bindingEventId: null,
                updatedAt: null
            };

            resolveCache.set(cacheKey, { data: empty, timestamp: Date.now() });
            return empty;

        } catch (error) {
            log.error('Resolve failed', error, { worldId, evmAddress });
            // Fail safe: return nulls
            return {
                worldId,
                evm: evmAddress,
                hederaAccountId: null,
                bindingEventId: null,
                updatedAt: null
            };
        }
    }
}
