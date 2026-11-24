import { pictoSvg } from '@/lib/picto';

/**
 * Pictos of the product's widgets, keyed like their copy (`widgetCatalog.<key>`
 * in the locale files). Each is the body of a 24×24 line drawing; a widget
 * hands `widgetPicto(key)` to its registration (`WidgetOptions.icon`) the way a
 * third-party widget would hand its own SVG. A test locks the keys to the
 * catalogue copy, so a new widget cannot ship without one.
 */
export const WIDGET_PICTOS: Readonly<Record<string, string>> = Object.freeze({
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
  dreams: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M16.5 3.5v3M15 5h3M20.2 8.5v2.4M19 9.7h2.4"/>',
  vault: '<path d="M12 5.5a3 3 0 0 0-5.5-1A3 3 0 0 0 4 9a3 3 0 0 0 0 5 3 3 0 0 0 2.5 4.5A3 3 0 0 0 12 19.5z"/><path d="M12 5.5a3 3 0 0 1 5.5-1A3 3 0 0 1 20 9a3 3 0 0 1 0 5 3 3 0 0 1-2.5 4.5A3 3 0 0 1 12 19.5z"/><path d="M12 5.5v14"/><path d="M8 10.5c1 0 2 .7 2 2M16 10.5c-1 0-2 .7-2 2"/>',
  recentMissions: '<path d="M12 3c3 2 4.5 5.2 4.5 9l-2 4h-5l-2-4C7.5 8.2 9 5 12 3z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M7.5 12L5 14v3l3.5-1M16.5 12l2.5 2v3l-3.5-1M10.5 19l1.5 2 1.5-2"/>',
  delegations: '<circle cx="7" cy="8" r="2.6"/><path d="M2.8 18.5c.5-2.6 2.1-4.2 4.2-4.2s3.7 1.6 4.2 4.2"/><path d="M13.5 11.5h7M17.5 8.5l3 3-3 3"/>',
  missionNetwork: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/>',
  allTodo: '<path d="M3.8 6.5l1.5 1.5 2.7-2.8M3.8 12.5l1.5 1.5 2.7-2.8M3.8 18.5l1.5 1.5 2.7-2.8"/><path d="M11 7h9M11 13h9M11 19h9"/>',
  projectTodo: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M9 13.3l2.2 2.2 4-4.2"/>',
  pullRequests: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/><path d="M6 7.5v9M18 16.5V10a3 3 0 0 0-3-3h-4M13 4.5 10.5 7l2.5 2.5"/>',
  jobs: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/><path d="M6 7.5v9"/><path d="M18 16.5V10a3 3 0 0 0-3-3h-4.5"/><path d="M12.5 4.8L10.5 7l2 2.2"/>',
  workflowRuns: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.6v6.8l5.3-3.4z"/>',
  projects: '<path d="M3.5 9a2 2 0 0 1 2-2H9l2 2h7.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M6.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5H18a1.5 1.5 0 0 1 1.5 1.5V9"/>',
  workingAgents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V5.5"/><circle cx="12" cy="4.2" r="1.2"/><circle cx="9.5" cy="12.8" r=".9"/><circle cx="14.5" cy="12.8" r=".9"/><path d="M10 16h4"/><path d="M3 12.5v2.5M21 12.5v2.5"/>',
  notificationCenter: '<path d="M3.5 13.5l2.5-8h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  taskQueue: '<rect x="4" y="4" width="16" height="4.5" rx="1.2"/><rect x="4" y="10.3" width="16" height="4.5" rx="1.2"/><rect x="4" y="16.6" width="10" height="3.9" rx="1.2"/>',
  injections: '<path d="M12 3v9.5M8.5 9L12 12.5 15.5 9"/><path d="M4 13.5v5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  newAgentChat: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 3.5V17H6a2 2 0 0 1-2-2z"/><path d="M12 7.5v6M9 10.5h6"/>',
  agentChat: '<path d="M3.5 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3 2.5V13h-.5a2 2 0 0 1-2-2z"/><path d="M15.5 8.5h3a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-.5v2.5L15 17h-3a2 2 0 0 1-2-2v-.5"/>',
  missionsList: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.6"/>',
  files: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h4"/>',
  gitBranches: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5c0 3.5-2 5-5.5 5H9.5a3 3 0 0 0-3 2"/>',
  gitGraph: '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><path d="M12 7v3M12 14v3"/><path d="M14 12h6"/><path d="M4 12h6"/>',
  gitPublish: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 10"/><path d="M12 19.5v-8M9 14l3-3 3 3"/>',
  agentTasks: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.3"/><path d="M5.2 6.9l1.4 1.4 2-2.6"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.3"/><path d="M13.5 6.8h7M13.5 17.3h7"/>',
  videoFactory: '<path d="M3.5 10h17v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.8 10l-.5-3.2a1.5 1.5 0 0 1 1.2-1.7l13.3-2.2a1.5 1.5 0 0 1 1.7 1.2l.4 2.4z"/><path d="M8.3 4.5l2.2 4M13.3 3.7l2.2 4"/>',
  docker: '<rect x="3" y="10" width="5.4" height="5.4" rx=".8"/><rect x="9.3" y="10" width="5.4" height="5.4" rx=".8"/><rect x="9.3" y="3.7" width="5.4" height="5.4" rx=".8"/><rect x="15.6" y="10" width="5.4" height="5.4" rx=".8"/><path d="M3 19.5c3 1.3 6 1.3 9 0s6-1.3 9 0"/>',
  timonDaemon: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M7.5 7.5h.01M7.5 16.5h.01" stroke-width="2.6"/><path d="M11 7.5h5.5M11 16.5h5.5"/>',
  missionDetails: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M12 10.8v5.2"/><path d="M12 7.7h.01" stroke-width="2.6"/>',
  agentSkills: '<path d="M11 3.5l2.2 5.3 5.3 2.2-5.3 2.2L11 18.5l-2.2-5.3L3.5 11l5.3-2.2z"/><path d="M18.5 15.5v5M16 18h5"/>',
  mcpServers: '<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>',
  trace: '<path d="M3 12h4l2.5-6.5 5 13 2.5-6.5h4"/>',
  botsRail: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16"/><circle cx="6.25" cy="8" r=".9"/><circle cx="6.25" cy="12" r=".9"/><circle cx="6.25" cy="16" r=".9"/><path d="M12 9h5.5M12 12.5h4"/>',
});

export function widgetPicto(key: string): string | undefined {
  const body = WIDGET_PICTOS[key];
  return body ? pictoSvg(body) : undefined;
}
