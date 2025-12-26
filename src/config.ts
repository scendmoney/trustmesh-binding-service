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
    IDENTITY_TOPIC_ID: z.string().min(1),
    MAGIC_PUBLIC_KEY: z.string().optional(),
    BINDING_SHARED_SECRET: z.string().optional(),
    CORS_ORIGINS: z.string().default('*'),
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
