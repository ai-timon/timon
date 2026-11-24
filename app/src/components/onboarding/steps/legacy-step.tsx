'use client';

/**
 * The stand-in for a step that has not shipped yet: it hands over to
 * the screen that does the job today (`/login`, `/setup`, `/setup/agent`), so
 * the onboarding stays usable at every merge. A step with no such screen
 * (`href: null`) is skipped, in the direction the reader was going — or
 * "Back" could never get past it.
 *
 * A full navigation, not the router: the screens it opens start their own
 * document (the login replaces it after signing in), and a reload must land
 * there rather than back on this stand-in.
 */
import { useEffect, type ComponentType, type ReactElement } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { useOnboarding } from '../onboarding-context';

export function legacyStep(href: string | null): ComponentType {
  function LegacyStep(): ReactElement {
    const { skip, direction } = useOnboarding();
    useEffect(() => {
      if (href !== null) window.location.replace(href);
      else skip(direction);
    }, [skip, direction]);
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t('onboarding.legacy.opening')}
      </div>
    );
  }
  return LegacyStep;
}
