// @ts-check
/**
 * Product profile. The key is the vault entry `LLMTR_API_KEY`, or the same
 * name in the daemon environment for an install that already exports it.
 * `modelsEndpoint` carries no `authFrom`: the public model list is not a
 * check of the key, and the key must not be sent to it.
 */
import { LLMTR_API_KEY_ENV, LLMTR_DEFAULT_MODEL, LLMTR_MODELS_URL } from './chat.js';
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const LLMTR_PROFILE = {
  id: 'llmtr',
  dialect: 'llmtr',
  label: 'LLMTR',
  vendor: 'LLMTR',
  custom: true,
  // No sign-in folder. The empty list is the manifest entry, not a second copy.
  credentialDirs: manifestBackend('llmtr').credentialDirs,
  env: { [LLMTR_API_KEY_ENV]: { secret: LLMTR_API_KEY_ENV } },
  envFrom: { [LLMTR_API_KEY_ENV]: LLMTR_API_KEY_ENV },
  modelsEndpoint: { url: LLMTR_MODELS_URL, format: 'openai' },
  defaultModel: LLMTR_DEFAULT_MODEL,
  models: [{ slug: LLMTR_DEFAULT_MODEL, label: LLMTR_DEFAULT_MODEL }],
};
