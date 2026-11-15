'use client';

/**
 * The common sections of a provider page, as the default entries of
 * `settings.provider.section` (`components/provider-page/provider-sections.ts`).
 *
 * Every section is filled, in page order: Connection and API key
 * (`provider-connection-section.tsx`, `provider-api-key-section.tsx`), Models,
 * Program (`program-section.tsx`) and own settings. The order, and a plugin's
 * way of taking the place of one of them, are fixed in `provider-sections.ts`.
 */
import type { ComponentType } from 'react';
import type { ProviderSectionKey } from '@/components/provider-page/provider-sections';
import { ApiKeySection } from './provider-api-key-section';
import { ConnectionSection } from './provider-connection-section';
import { ProgramSection } from './program-section';
import { ProviderModelsSection } from './provider-models-section';
import { ProviderSettingsSection } from './provider-settings-section';

export const COMMON_PROVIDER_SECTIONS: Readonly<Record<ProviderSectionKey, ComponentType>> = {
  connection: ConnectionSection,
  apiKey: ApiKeySection,
  models: ProviderModelsSection,
  program: ProgramSection,
  settings: ProviderSettingsSection,
};
