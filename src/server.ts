import { createApp } from './app';
import { config } from './config';
import { log } from './util/log';

const app = createApp();

app.listen(config.PORT, () => {
    log.info(`TrustMesh Binding Service running on port ${config.PORT}`);
});
