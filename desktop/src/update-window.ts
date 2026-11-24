import { BrowserWindow, shell } from 'electron';
import { themeFor, updateCopy, updatePage, updateProgressPage, type Progress, type UpdateOffer } from './data-update.js';

/** How often the approval screen counts the missions again while it waits for a choice. */
const MISSIONS_POLL_MS = 5_000;

/** No preload, Node access or remote document is needed before the daemon starts. */
export class UpdateWindow {
  readonly window: BrowserWindow;
  private approved = false;
  /** Set when "Go back to x.y.z" made the refusal: `choice` is then false, and the caller puts the previous AppImage back. */
  rollbackChosen = false;
  private finished = false;
  private choose: ((approve: boolean) => void) | undefined;
  readonly choice: Promise<boolean>;
  private poll: NodeJS.Timeout | undefined;
  /**
   * `countMissions`: the missions the service would stop if approved now (P3).
   * Counted while the screen waits; when some run, it says how many, "Quit"
   * becomes "Wait" (the service keeps running them on the installed
   * version) and "Update" becomes "Update anyway".
   * `preApproved`: "Restart and install" already approved this transition
   * (`update-consent.ts`), after the missions were counted: the window only
   * shows the progress, and its choice is made.
   * `rollback`: the AppImage this update replaced is still beside it; the
   * screen offers "Go back to x.y.z" next to "Quit".
   */
  constructor(private offer: UpdateOffer, notesPath: string, private locale: string, scheme: 'light' | 'dark' = 'dark',
    private countMissions?: () => Promise<number>, preApproved = false, rollback = false) {
    const page = preApproved ? updateProgressPage(offer, locale, scheme) : updatePage(offer, notesPath, locale, scheme, rollback);
    if (preApproved) this.countMissions = undefined;
    const size = preApproved ? { width: 560, height: 300, minWidth: 420, minHeight: 240 } : { width: 780, height: 720, minWidth: 480, minHeight: 480 };
    this.window = new BrowserWindow({ ...size,
      title: 'Timon', backgroundColor: themeFor(scheme).background, autoHideMenuBar: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    this.choice = new Promise(resolve => { this.choose = resolve; });
    if (preApproved) { this.approved = true; this.choose?.(true); }
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'timon-update:approve' && !this.approved && !this.rollbackChosen) {
        this.approved = true;
        this.stopCounting();
        this.progress(updateCopy(locale).working);
        this.choose?.(true);
      } else if (url === 'timon-update:quit' && !this.approved) {
        this.choose?.(false);
      } else if (url === 'timon-update:rollback' && rollback && !this.approved && !this.rollbackChosen) {
        this.rollbackChosen = true;
        this.stopCounting();
        this.progress(updateCopy(locale).rollbackRestarting(offer));
        this.choose?.(false);
      } else if (page.links.includes(url)) void shell.openExternal(url);
    });
    this.window.on('closed', () => { this.stopCounting(); });
    if (this.countMissions) {
      this.window.webContents.on('did-finish-load', () => { void this.showMissions(); });
      this.poll = setInterval(() => { void this.showMissions(); }, MISSIONS_POLL_MS);
    }
    this.window.on('close', event => {
      // Once approved, closing a portable shell would interrupt its own migration.
      if (this.approved && !this.finished) event.preventDefault();
      else this.choose?.(false);
    });
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page.html)}`);
  }
  private stopCounting(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }
  private async showMissions(): Promise<void> {
    if (!this.countMissions || this.approved || this.rollbackChosen) return;
    const count = await this.countMissions().catch(() => 0);
    if (this.approved || this.rollbackChosen || this.window.isDestroyed()) return;
    const copy = updateCopy(this.locale);
    const text = count > 0 ? copy.missions(count, this.offer.from) : '';
    void this.window.webContents.executeJavaScript(`
      { const m = document.getElementById('missions'); m.textContent = ${JSON.stringify(text)}; m.hidden = ${count > 0 ? 'false' : 'true'}; }
      document.getElementById('quit').textContent = ${JSON.stringify(count > 0 ? copy.wait : copy.quit)};
      document.getElementById('approve').textContent = ${JSON.stringify(count > 0 ? copy.approveAnyway : copy.approve)};
    `).catch(() => { /* A window being destroyed no longer needs the count. */ });
  }
  progress(message: string, progress?: Progress | null): void {
    if (this.window.isDestroyed()) return;
    const bytes = progress && progress.totalBytes > 0
      ? ` (${updateCopy(this.locale).bytes(Math.min(progress.copiedBytes, progress.totalBytes), progress.totalBytes)})` : '';
    // The progress-only page has no intro, missions or buttons.
    void this.window.webContents.executeJavaScript(`
      for (const id of ['intro', 'missions']) { const e = document.getElementById(id); if (e) e.hidden = true; }
      document.getElementById('status').textContent = ${JSON.stringify(message + bytes)};
      for (const id of ['approve', 'quit', 'rollback']) { const b = document.getElementById(id); if (b) { b.setAttribute('aria-disabled', 'true'); b.tabIndex = -1; } }
      const p = document.getElementById('progress'); p.hidden = false;
      ${progress && progress.totalBytes > 0 ? `p.max = ${progress.totalBytes}; p.value = ${Math.min(progress.copiedBytes, progress.totalBytes)};` : "p.removeAttribute('value');"}
    `).catch(() => { /* A window being destroyed no longer needs progress. */ });
  }
  close(): void { this.finished = true; this.stopCounting(); this.window.destroy(); }
}
