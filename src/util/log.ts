export const log = {
    info: (msg: string, meta?: any) => {
        console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() }));
    },
    error: (msg: string, error?: any, meta?: any) => {
        console.error(JSON.stringify({ level: 'error', msg, error: error instanceof Error ? error.message : error, ...meta, ts: new Date().toISOString() }));
    },
    warn: (msg: string, meta?: any) => {
        console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() }));
    }
};
