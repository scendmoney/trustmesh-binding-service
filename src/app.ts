import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { log } from './util/log';
import { ResolveService } from './services/binding/resolveService';
import { BindingService } from './services/binding/bindingService';
import { FounderBindingService } from './services/binding/founderBindingService';
import { CurrentnessReadError, CurrentnessService } from './services/binding/currentnessService';
import { IdentityRegistrationService } from './services/binding/identityRegistrationService';
import type {
    IdentityRegistrationBlockedReasonV1,
    IdentityRegistrationBlockedResponseV1
} from './services/binding/types';
import { z } from 'zod';

const identityRegistrationBlocked = (
    reason: IdentityRegistrationBlockedReasonV1,
    message: string
): IdentityRegistrationBlockedResponseV1 => ({
    responseVersion: 'v1',
    status: 'blocked',
    reason,
    retryable: false,
    message
});

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
    const identityRegistrationLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        message: identityRegistrationBlocked('RATE_LIMITED', 'Too many identity registration attempts.')
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

    const currentnessSchema = z.object({
        requestVersion: z.literal('v1'),
        identity: z.object({
            canonicalDid: z.string().min(1),
            stableIdentifier: z.string().min(1),
            issuer: z.string().min(1)
        }).strict()
    }).strict();

    const identityRegistrationSchema = z.object({
        requestVersion: z.literal('v1'),
        canonicalDid: z.string().min(1).max(512).refine(value => value.trim().length > 0),
        stableIdentifier: z.string().min(1).max(512).refine(value => value.trim().length > 0),
        issuer: z.string().min(1).max(512).refine(value => value.trim().length > 0),
        evmPublicAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        purpose: z.literal('eugene.business.admin.custody'),
        consentReceiptRef: z.string().min(1).max(1024).refine(value => value.trim().length > 0),
        idempotencyKey: z.string().min(1).max(200).refine(value => value.trim().length > 0),
        requestedAt: z.string().datetime({ offset: true })
    }).strict();

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

    app.post('/v1/identity-binding/register', identityRegistrationLimiter, async (req, res) => {
        if (!config.WORLDS_BUILDER_SERVICE_TOKEN) {
            res.status(503).json(identityRegistrationBlocked(
                'SERVICE_AUTHENTICATION_UNAVAILABLE',
                'Identity registration authentication is not configured.'
            ));
            return;
        }
        if (req.header('x-worlds-builder-service-token') !== config.WORLDS_BUILDER_SERVICE_TOKEN) {
            res.status(401).json(identityRegistrationBlocked(
                'AUTHENTICATION_FAILURE',
                'Missing or invalid Worlds Builder service token.'
            ));
            return;
        }

        const operationOwnerRef = req.header('x-trustmesh-operation-owner') ?? '';

        try {
            const body = identityRegistrationSchema.parse(req.body);
            const result = await IdentityRegistrationService.register(body, { operationOwnerRef });
            const status = result.status === 'bound'
                ? 200
                : result.status === 'pending'
                    ? 202
                    : result.reason === 'OPERATION_OWNER_REQUIRED'
                        ? 428
                    : result.reason === 'IDENTITY_CONFLICT' ||
                        result.reason === 'IDEMPOTENCY_KEY_REUSE' ||
                        result.reason === 'UNCERTAIN_OUTCOME_BLOCKED' ||
                        result.reason === 'CURRENTNESS_NOT_CURRENT'
                        ? 409
                        : 503;
            res.status(status).json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json(identityRegistrationBlocked(
                    'INVALID_REQUEST',
                    'Invalid identity registration request.'
                ));
                return;
            }

            log.error('Identity registration route failed');
            res.status(500).json(identityRegistrationBlocked(
                'INTERNAL_FAILURE',
                'Identity registration failed closed.'
            ));
        }
    });

    app.post('/v1/currentness', generalLimiter, async (req, res) => {
        if (!config.CURRENTNESS_SERVICE_TOKEN) {
            res.status(503).json({
                responseVersion: 'v1',
                status: 'error',
                code: 'CAPABILITY_ABSENT',
                message: 'Currentness authentication is not configured.'
            });
            return;
        }

        if (req.header('x-trustmesh-currentness-token') !== config.CURRENTNESS_SERVICE_TOKEN) {
            res.status(401).json({
                responseVersion: 'v1',
                status: 'error',
                code: 'AUTHENTICATION_FAILURE',
                message: 'Missing or invalid currentness service token.'
            });
            return;
        }

        try {
            const body = currentnessSchema.parse(req.body);
            const result = await CurrentnessService.read(body);
            res.status(result.disposition === 'AMBIGUOUS' ? 409 : 200).json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({
                    responseVersion: 'v1',
                    status: 'error',
                    code: 'INVALID_REQUEST',
                    message: 'Invalid currentness request.',
                    details: error.errors
                });
                return;
            }

            if (error instanceof CurrentnessReadError) {
                const status = error.code === 'TIMEOUT'
                    ? 504
                    : error.code === 'UPSTREAM_AUTHENTICATION_FAILURE' || error.code === 'UPSTREAM_PERMANENT_FAILURE'
                        ? 502
                        : 503;
                res.status(status).json({
                    responseVersion: 'v1',
                    status: 'error',
                    code: error.code,
                    message: error.message
                });
                return;
            }

            log.error('Currentness route error', error);
            res.status(500).json({
                responseVersion: 'v1',
                status: 'error',
                code: 'INTERNAL_FAILURE',
                message: 'Currentness read failed.'
            });
        }
    });

    return app;
};
