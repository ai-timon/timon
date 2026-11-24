'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/**
 * Keeps a plugin's component from taking the page down with it. `fallback`
 * replaces the error card where the product has something of its own to
 * draw instead (a mascot head whose pack failed).
 */
export class PluginBoundary extends Component<{ pluginId: string; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] render failed`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{t('pluginHost.renderFailed', { id: this.props.pluginId })}</div>;
    }
    return this.props.children;
  }
}
