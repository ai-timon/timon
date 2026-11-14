'use client';

/**
 * The logo of an LLM brand: a provider (`backend.brand`) or a model (its
 * slug).
 *
 * Extracted from the old `llm-grid.tsx` grid, since removed in favour of the
 * ModelPicker: the `@timon/ui` kit serves it to PLUGINS (§10.15), and
 * importing a whole picker for a logo would pull its modals into every plugin
 * bundle. The path stays the only shared thing.
 */

import { cn } from '@/lib/utils';
import { useBackendCatalog, type BackendCatalog } from '@/lib/backends';
import {
  AnthropicIcon, ClaudeIcon, DeepSeekIcon, GeminiIcon, GithubIcon, GrokIcon, LlmtrIcon, MetaIcon, MistralIcon,
  MoonshotIcon, NousIcon, OllamaIcon, OpenaiIcon, OpenCodeIcon, PiIcon, QwenIcon, XaiIcon, ZhipuIcon,
} from '@/components/brand-icons';

type BrandIcon = (props: { className?: string }) => React.ReactElement;

/** Brand key → path. The keys come from `backend.brand`, declared by the
 *  profile: the UI never compares `backend.id` to a literal name to pick a
 *  logo. */
const BRAND_ICONS: Record<string, BrandIcon> = {
  anthropic: AnthropicIcon,
  claude: ClaudeIcon,
  openai: OpenaiIcon,
  xai: XaiIcon,
  grok: GrokIcon,
  ollama: OllamaIcon,
  moonshot: MoonshotIcon,
  deepseek: DeepSeekIcon,
  mistral: MistralIcon,
  qwen: QwenIcon,
  gemini: GeminiIcon,
  zhipu: ZhipuIcon,
  meta: MetaIcon,
  github: GithubIcon,
  opencode: OpenCodeIcon,
  nous: NousIcon,
  pi: PiIcon,
  llmtr: LlmtrIcon,
};

/** The brands offered when illustrating a hand-added backend: everything we
 *  have a path for, nothing else. Exported so the picker does not keep a
 *  second list, which would drift. */
export const BRAND_KEYS = Object.keys(BRAND_ICONS);

/** An image served by OUR upload route, or the SVG logo a provider declared
 *  (C9): a `data:` URL rendered by `<img>`, where no script runs (the daemon
 *  already refused it if it carried one). Anything else (emoji) is drawn as
 *  is. No other scheme: a menu that fetched a third-party address on every
 *  opening would leak the install. */
export function isPicture(icon: string): boolean {
  return icon.startsWith('/api/uploads/') || icon.startsWith('data:image/svg+xml;base64,');
}

/**
 * Brand guessed from the model SLUG.
 *
 * Only for aggregators: Ollama Cloud serves kimi, gpt-oss and deepseek under
 * one banner, so the backend's brand says nothing about the model. It also
 * tells the product from its maker: a `grok-4.6` model carries the Grok logo,
 * while its provider carries xAI's. For everything else, `backend.brand` is
 * authoritative.
 */
export function brandOfSlug(slug: string, catalog: BackendCatalog): string | null {
  const value = slug.toLowerCase();
  // The fragments the providers declared (`modelBrands`), served with the catalogue. They name the
  // product, not the house: Anthropic signs the provider on the left, Claude its models on the right.
  return catalog.modelBrands?.find(({ match }) => value.includes(match))?.brand ?? null;
}

/**
 * The logo of a model or a provider, in order of precedence:
 *
 *   1. `icon`: a human's EXPLICIT choice for THIS object (emoji or uploaded
 *      image). Nothing overrides it: it is the only level where someone decided.
 *   2. `brand`: the brand the profile declares for this exact object.
 *   3. `slug`: the guess, which only exists for aggregators; the fragments
 *      come from the catalogue (`modelBrands`), never from here.
 *   4. `fallbackIcon` / `fallbackBrand`: the banner, when the model said
 *      nothing about itself: the models of a hand-added backend thus inherit
 *      the logo it was given.
 *
 * An unknown brand falls back to a badge with the initial, so a model that
 * just appeared at an aggregator can still be shown.
 */
type BrandMarkProps = { brand?: string; slug?: string; icon?: string; fallbackIcon?: string; fallbackBrand?: string; className?: string };

export function BrandMark(props: BrandMarkProps): React.ReactElement {
  // Only a model slug with no brand of its own needs the catalogue to be guessed.
  return props.brand === undefined && props.slug ? <SlugBrandMark {...props} /> : <Logo {...props} guessed={props.brand ?? null} />;
}

function SlugBrandMark(props: BrandMarkProps): React.ReactElement {
  const catalog = useBackendCatalog();
  return <Logo {...props} guessed={props.slug ? brandOfSlug(props.slug, catalog) : null} />;
}

function Logo(
  { guessed, slug, brand, icon, fallbackIcon, fallbackBrand, className }: BrandMarkProps & { guessed: string | null },
): React.ReactElement {
  const picture = icon ?? (guessed ? null : fallbackIcon) ?? null;
  if (picture && isPicture(picture)) {
    // eslint-disable-next-line @next/next/no-img-element -- a file served by
    // the daemon, of unknown size: `next/image` would require a loader for a
    // thumbnail already shrunk client-side.
    return <img src={picture} alt="" className={cn('shrink-0 rounded-md object-cover', className)} />;
  }
  if (picture) {
    return (
      <span className={cn('grid place-items-center leading-none', className)} aria-hidden>{picture}</span>
    );
  }
  const Icon = BRAND_ICONS[guessed ?? fallbackBrand ?? ''];
  if (!Icon) {
    const initial = (slug ?? brand ?? fallbackBrand ?? '?').trim()[0]?.toUpperCase() ?? '?';
    return (
      <span className={cn('grid place-items-center rounded-md bg-muted font-semibold', className)}>
        {initial}
      </span>
    );
  }
  return <Icon className={cn('shrink-0', className)} />;
}
