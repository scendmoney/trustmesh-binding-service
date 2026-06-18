import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    PORT: z.string().default('3002'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HEDERA_NETWORK: z.enum(['mainnet', 'testnet', 'previewnet']).default('testnet'),
    HEDERA_OPERATOR_ID: z.string().min(1),
    HEDERA_OPERATOR_KEY: z.string().min(1),
    MIRROR_NODE_URL: z.string().url().default('https://testnet.mirrornode.hedera.com/api/v1'),
    MIRROR_NODE_AUTH_TYPE: z.enum(['none', 'bearer', 'x-api-key']).default('none'),
    MIRROR_NODE_AUTH_TOKEN: z.string().optional(),
    IDENTITY_TOPIC_ID: z.string().min(1),
    MAGIC_PUBLIC_KEY: z.string().optional(),
    BINDING_SHARED_SECRET: z.string().optional(),
    WORLDS_BUILDER_SERVICE_TOKEN: z.string().optional(),
    RESOLVE_MAX_PAGES: z.coerce.number().default(25),
    MAGIC_JWT_ENABLED: z.enum(['true', 'false']).default('false'),
    CORS_ORIGINS: z.string().default('*'),
    MIRROR_NODE_TIMEOUT_MS: z.coerce.number().default(4000),
    HEDERA_ALIAS_POLL_ATTEMPTS: z.coerce.number().default(12),
    HEDERA_ALIAS_POLL_DELAY_MS: z.coerce.number().default(750),
});

const parseEnv = () => {
    try {
        return envSchema.parse(process.env);
    } catch (error) {
        if (error instanceof z.ZodError) {
            console.error('❌ Invalid environment variables:', JSON.stringify(error.format(), null, 2));
        } else {
            console.error('❌ Failed to load environment variables:', error);
        }
        process.exit(1);
    }
};

export const config = parseEnv();
