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
    private static async fetchMirrorMessages(topicId: string, limit: number, nextLink?: string): Promise<{ messages: any[], next?: string }> {
        try {
            const url = nextLink ? `${config.MIRROR_NODE_URL}${nextLink}` : `${config.MIRROR_NODE_URL}/topics/${topicId}/messages?limit=${limit}&order=desc`;

            // Add a timeout to the fetch
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

            try {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) throw new Error(`Mirror node error: ${response.statusText}`);
                const data = await response.json();
                return {
                    messages: data.messages || [],
                    next: data.links?.next
                };
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            log.error('Failed to fetch from mirror node', error);
            // Return empty to fail soft
            return { messages: [], next: undefined };
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

        const normalizedEvm = evmAddress.toLowerCase();
        let currentLink: string | undefined = undefined;
        let pagesScanned = 0;
        const maxPages = config.RESOLVE_MAX_PAGES;

        try {
            while (pagesScanned < maxPages) {
                const { messages, next } = await this.fetchMirrorMessages(config.IDENTITY_TOPIC_ID, 100, currentLink);
                if (!messages || messages.length === 0) break;

                // Find valid binding in this batch
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

                if (!next) break; // End of stream

                currentLink = next;
                pagesScanned++;
            }

            // Not found after scanning max pages or hitting end
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
