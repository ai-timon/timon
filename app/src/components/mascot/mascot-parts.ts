/**
 * The parts mascot packs add, read from the `mascot.parts` slot — the one
 * registry, no list of its own (docs/AGENT-MASCOT.md, "Mascot packs").
 *
 * Each entry was checked when it registered (`slots.ts`): its data is valid,
 * its accessory markup readable, its id declared by its plugin's manifest. A
 * part whose plugin leaves is gone from the slot, and every look that wears
 * it falls back to the job's default for that one field (`normalizeAgentLook`).
 */
import { useSyncExternalStore, type ComponentType } from 'react';
import { slotEntries, slotEntry, slotVersion, subscribeSlots } from '@/lib/plugin-host/slots';
import {
  MASCOT_PARTS_SLOT, MASCOT_PART_TYPES, isMascotPartId, mascotPartLabel,
  type MascotPart, type MascotPartId, type MascotPartType,
} from '@/lib/mascot/parts-contract';
import { mascotPackLabel } from '@/lib/mascot/parts-declarations';
import { getLocale } from '@/lib/i18n';

export type MascotPartOf<T extends MascotPartType> = Extract<MascotPart, { type: T }>;

/** A part as the pickers show it. */
export type MascotPartEntry = {
  id: MascotPartId;
  pluginId: string;
  type: MascotPartType;
  /** In the reader's language. */
  label: string;
  part: MascotPart;
};

/** One pack: its parts, in registration order. */
export type MascotPack = {
  pluginId: string;
  /** The plugin's name in the gallery, or its id. */
  label: string;
  parts: readonly MascotPartEntry[];
};

/** The part `id` of `type` registered right now, or `null` (unknown, another type, plugin gone). */
export function mascotPartOf<T extends MascotPartType>(type: T, id: unknown): MascotPartOf<T> | null {
  if (!isMascotPartId(id)) return null;
  const part = slotEntry(MASCOT_PARTS_SLOT, id)?.mascotPart;
  return part && part.type === type ? part as MascotPartOf<T> : null;
}

/** A head a pack draws itself, with the plugin that registered it (for its error boundary). */
export type MascotPackHead = { pluginId: string; Head: ComponentType };

/**
 * The head a pack draws for `shape`, or `null`: a product skull, a pack's
 * skull of four numbers, an unknown id, a pack gone. The SDK types the
 * component loosely (it has no React); the registry checked it is a function.
 */
export function mascotHeadOf(shape: unknown): MascotPackHead | null {
  if (!isMascotPartId(shape)) return null;
  const entry = slotEntry(MASCOT_PARTS_SLOT, shape);
  const part = entry?.mascotPart;
  if (!entry || part?.type !== 'shape' || !part.head) return null;
  return { pluginId: entry.pluginId, Head: part.head as ComponentType };
}

export function isRegisteredPart(type: MascotPartType, id: unknown): id is MascotPartId {
  return mascotPartOf(type, id) !== null;
}

/** Every registered part, grouped by pack in the order the packs came. */
export function mascotPacks(): MascotPack[] {
  const locale = getLocale();
  const packs = new Map<string, MascotPartEntry[]>();
  for (const entry of slotEntries(MASCOT_PARTS_SLOT)) {
    const part = entry.mascotPart;
    if (!part || !entry.key) continue;
    const id = `${entry.pluginId}:${entry.key}` as MascotPartId;
    const list = packs.get(entry.pluginId) ?? [];
    list.push({ id, pluginId: entry.pluginId, type: part.type, label: mascotPartLabel(part.label, locale, entry.key), part });
    packs.set(entry.pluginId, list);
  }
  return [...packs].map(([pluginId, parts]) => ({ pluginId, label: mascotPackLabel(pluginId) ?? pluginId, parts }));
}

/** The ids of the registered parts of `type`, every pack together. */
export function mascotPartIds(type: MascotPartType): MascotPartId[] {
  return mascotPacks().flatMap((pack) => pack.parts.filter((p) => p.type === type).map((p) => p.id));
}

/** The label of a part, `null` when it is not registered. */
export function mascotPartName(id: unknown): string | null {
  if (!isMascotPartId(id)) return null;
  const entry = slotEntry(MASCOT_PARTS_SLOT, id);
  if (!entry?.mascotPart) return null;
  return mascotPartLabel(entry.mascotPart.label, getLocale(), entry.key ?? id);
}

/** Re-renders when a pack comes or goes (any slot change: the registry has one version). */
export function useMascotPartsVersion(): number {
  return useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);
}

export { MASCOT_PART_TYPES };
