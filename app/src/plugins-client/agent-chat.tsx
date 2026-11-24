'use client';

import dynamic from 'next/dynamic';
/**
 * Client half of `@timon/agent-chat`: one card per configured agent.
 *
 * Unlike every other bundled half, this one does not know its cards at mount:
 * they are its config, stored by the daemon, and read asynchronously. It
 * therefore registers as the list arrives and re-registers whenever it changes
 * — which is what `ctx.onDispose` is for, so a module switched off stops
 * putting cards back.
 *
 * A registration is keyed by the instance id, so the host persists each card's
 * placement under `plugin:@timon/agent-chat:<id>`: two cards of the same widget
 * keep their own rail, their own height, and their own spot in the palette.
 */

import { useSyncExternalStore, type ComponentType } from 'react';

import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import {
  subscribeInstances,
  loadInstances,
  saveInstance,
  currentInstances,
  deleteInstance,
  instanceTitle,
  type AgentChatInstance,
} from './agent-chat/instances';
import type { BundledClientContext, BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const AgentChatCard = dynamic(() => import('./agent-chat/agent-chat-card').then((m) => m.AgentChatCard), { ssr: false });
const InstanceConfig = dynamic(() => import('./agent-chat/instance-config').then((m) => m.InstanceConfig), { ssr: false });

/** Catalogue id — namespaced, like every plugin we ship. */
export const AGENT_CHAT_MODULE = '@timon/agent-chat';

/** Registration key of the card that creates the others. Not a UUID, so it can
 *  never collide with an instance id and keeps a stable placement of its own. */
export const CLE_NOUVELLE_CARTE = 'new';

/** A chat needs room: a 260 px default would show the composer and two lines. */
const HAUTEUR_DEFAUT = 520;
const HAUTEUR_MIN = 280;

function useInstances(): readonly AgentChatInstance[] {
  return useSyncExternalStore(subscribeInstances, currentInstances, currentInstances);
}

/**
 * The card of one instance. It reads the store rather than closing over the
 * instance: editing the config must repaint the card, not wait for a
 * re-registration that would only happen if its title changed too.
 */
function carteDeLInstance(id: string): (props: WidgetProps) => React.ReactNode {
  return function CarteAgentChat(props: WidgetProps) {
    const instance = useInstances().find((i) => i.id === id);
    // Deleted between the store publishing and the host repainting.
    if (!instance) return null;
    return (
      <AgentChatCard
        {...props}
        instance={instance}
        onSave={(suivante) => void saveInstance(suivante)}
        onDelete={() => void deleteInstance(id)}
      />
    );
  };
}

/**
 * The creation card, always registered.
 *
 * It is the only entry point for a *second* instance: the host owns placing,
 * moving and removing cards, but it has no notion of "add another one of
 * those" — a widget is normally a singleton. A blank card sitting in the
 * palette gives that gesture without inventing host UI for it.
 */
function NouvelleCarte({ handle, className, onReplace }: WidgetProps) {
  return (
    <Tile title={t('agentChat.newCard')} className={className} bodyClassName="p-0" actions={handle}>
      <p className="px-3 pt-3 text-[11px] leading-snug text-muted-foreground/70">
        {t('agentChat.newCardHint')}
      </p>
      <InstanceConfig
        instance={null}
        onSave={async (instance) => {
          if (!await saveInstance(instance)) return false;
          onReplace?.(`plugin:${AGENT_CHAT_MODULE}:${instance.id}`);
          return true;
        }}
        onCancel={() => {}}
      />
    </Tile>
  );
}

export const agentChatClient: BundledClientPlugin = {
  module: AGENT_CHAT_MODULE,
  apply(ctx: BundledClientContext) {
    ctx.register(
      {
        slot: 'cockpit.widget',
        key: CLE_NOUVELLE_CARTE,
        widget: {
          title: t('widgetCatalog.newAgentChat.title'), icon: widgetPicto('newAgentChat'), description: t('widgetCatalog.newAgentChat.description'),
          height: HAUTEUR_DEFAUT,
          heightMode: 'fill',
          minHeight: HAUTEUR_MIN,
          frame: 'none',
        },
      },
      // The slot registry only types propless components — the ordinary case,
      // where the host frames the card. `frame: 'none'` hands `WidgetProps` to
      // the widget instead; `registerWidget` casts the same way, once.
      NouvelleCarte as ComponentType,
    );

    // Registered cards, by instance id. The title is kept beside the disposer:
    // it is baked into the registration (the host reads it for the header, the
    // drag preview and the palette), so renaming a card means re-registering it
    // — under the same key, hence at the same place.
    const cartes = new Map<string, { titre: string; dispose: () => void }>();
    let vivant = true;
    ctx.onDispose(() => { vivant = false; });

    const synchroniser = (): void => {
      if (!vivant) return;
      const liste = currentInstances();
      for (const instance of liste) {
        const titre = instanceTitle(instance);
        const carte = cartes.get(instance.id);
        if (carte?.titre === titre) continue;
        carte?.dispose();
        cartes.set(instance.id, {
          titre,
          dispose: ctx.register(
            {
              slot: 'cockpit.widget',
              key: instance.id,
              widget: {
                title: titre,
                catalogTitle: t('widgetCatalog.agentChat.title'),
                icon: widgetPicto('agentChat'),
                description: t('widgetCatalog.agentChat.description', { agent: instance.agent }),
                height: HAUTEUR_DEFAUT,
                heightMode: 'fill',
                minHeight: HAUTEUR_MIN,
                frame: 'none',
                // A first-placement preference only: it only serves the seeded
                // card, which must open in the centre of the cockpit.
                ...(instance.zone ? { zone: instance.zone } : {}),
              },
            },
            carteDeLInstance(instance.id) as ComponentType,
          ),
        });
      }
      for (const [id, carte] of [...cartes]) {
        if (liste.some((i) => i.id === id)) continue;
        carte.dispose();
        cartes.delete(id);
      }
    };

    ctx.onDispose(subscribeInstances(synchroniser));
    synchroniser();
    void loadInstances();
  },
};
