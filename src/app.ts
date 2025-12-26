import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { log } from './util/log';
import { ResolveService } from './services/binding/resolveService';
import { BindingService } from './services/binding/bindingService';
import { z } from 'zod';

export const createApp = () => {
    const app = express();

    // Security Middleware
    app.use(helmet());
    app.use(cors({ origin: config.CORS_ORIGINS }));
    app.use(express.json({ limit: '50kb' })); // Strict body limit

    // Rate Limiting
    const generalLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 60,
        message: 'Too many requests'
    });
    const writeLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        message: 'Too many binding attempts'
    });

    // Validation Schemas
    const bindSchema = z.object({
        worldId: z.string().min(1),
        evmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        hederaAccountId: z.string().regex(/^0\.0\.\d+$/),
        proof: z.object({
            type: z.enum(['magic_jwt', 'sig', 'otp_attestation']),
            value: z.string().min(1)
        })
    });

    // Routes

    // 1. Health
    app.get('/health', (req, res) => {
        res.json({ ok: true, service: 'trustmesh-binding-service', version: '1.0.0' });
    });

    // 2. Resolve
    app.get('/v1/resolve', generalLimiter, async (req, res) => {
        const worldId = req.query.worldId as string;
        const evm = req.query.evm as string;

        if (!worldId || !evm) {
            res.status(400).json({ error: 'Missing worldId or evm' });
            return
        }

        const result = await ResolveService.resolve(worldId, evm);
        res.json(result);
    });

    // 3. Status
    app.get('/v1/status', generalLimiter, async (req, res) => {
        const worldId = req.query.worldId as string;
        const a = req.query.a as string; // assume EVM for now, can extend

        if (!worldId || !a) {
            res.status(400).json({ error: 'Missing parameters' });
            return
        }

        // Check binding for 'a'
        const result = await ResolveService.resolve(worldId, a);

        res.json({
            worldId,
            a,
            isBound: !!result.hederaAccountId,
            bindingEventId: result.bindingEventId
        });
    });

    // 4. Bind (Write)
    app.post('/v1/bind', writeLimiter, async (req, res) => {
        try {
            const body = bindSchema.parse(req.body);

            // Attempt binding
            const result = await BindingService.bind(body);
            res.json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({ error: 'Invalid input', details: error.errors });
            } else if (error instanceof Error && error.message === 'Invalid proof') {
                res.status(401).json({ error: 'Unauthorized: Invalid proof' });
            } else if (error instanceof Error && error.message === 'magic_jwt proof type is disabled') {
                res.status(501).json({ error: 'Not Implemented: magic_jwt is disabled' });
            } else {
                log.error('Binding error', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    return app;
};
