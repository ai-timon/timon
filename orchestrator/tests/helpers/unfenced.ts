/**
 * For suites about what a mission launches, not about the fence: with the
 * launcher built in the checkout (`native/timon-fence/build/`, which the
 * source installer makes), every mission they spawn would start as
 * `timon-fence --policy … -- <cli>` and their assertions on the command
 * line would read the launcher. The fence has suites of its own
 * (`resources-fence.test.ts`, `host/landlock.test.ts`).
 *
 * Import it right after `test-home.js`: the configuration it sets is the
 * one the suite's later `config()` calls start from. A suite that reloads
 * the configuration passes its own through `withoutFence`.
 */
import { config, setConfig } from '../../src/config/load.js';
import type { TimonConfig } from '../../src/config/schema.js';

export function withoutFence(cfg: TimonConfig): TimonConfig {
  return { ...cfg, host: { ...cfg.host, isolation: { ...cfg.host.isolation, filesystem: 'off' } } };
}

setConfig(withoutFence(config()));
