import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { log } from './util/log';
import { ResolveService } from './services/binding/resolveService';
import { BindingService } from './services/binding/bindingService';
import { FounderBindingService } from './services/binding/founderBindingService';
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

    const founderBindingSchema = z.object({
        founder: z.object({
            issuer: z.string().min(1),
            stableIdentifier: z.string().min(1),
            canonicalDid: z.string().min(1),
            displayName: z.string().min(1).optional(),
            email: z.string().email().optional(),
            evmPublicAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional()
        }),
        claimIntent: z.object({
            claimVersion: z.literal('v0.1'),
            claimId: z.string().min(1),
            requestedAt: z.string().min(1),
            organismId: z.string().min(1),
            sourceAssessmentId: z.string().min(1),
            sourceIntakeId: z.string().min(1),
            sourceReportId: z.string().min(1),
            sourceCompilerRunId: z.string().min(1),
            requestedRole: z.literal('foundingSteward')
        })
    });

    const requireWorldsBuilderToken = (req: express.Request): boolean => {
        if (!config.WORLDS_BUILDER_SERVICE_TOKEN) {
            return true;
        }

        return req.header('x-worlds-builder-service-token') === config.WORLDS_BUILDER_SERVICE_TOKEN;
    };

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
            return;
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
            return;
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

    app.post('/v2/founder-binding/resolve-or-provision', writeLimiter, async (req, res) => {
        if (!requireWorldsBuilderToken(req)) {
            res.status(401).json({
                status: 'unbound',
                reason: 'unauthorized',
                message: 'Missing or invalid Worlds Builder service token.'
            });
            return;
        }

        try {
            const body = founderBindingSchema.parse(req.body);
            const result = await FounderBindingService.resolveOrProvision(body);

            if (result.status === 'unbound' && result.reason === 'conflict') {
                res.status(409).json(result);
                return;
            }

            res.status(result.status === 'bound' ? 200 : 503).json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({
                    error: 'Invalid founder binding input',
                    details: error.errors
                });
                return;
            }

            log.error('Founder binding route error', error);
            res.status(500).json({
                status: 'unbound',
                reason: 'serviceUnavailable',
                message: 'Founder binding route failed.'
            });
        }
    });

    return app;
};
