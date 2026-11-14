/** First import of every daemon entry: it may replace the process (`host/env-proxy.ts`). */
import { enableEnvProxyAtBoot } from './host/env-proxy.js';

enableEnvProxyAtBoot();
