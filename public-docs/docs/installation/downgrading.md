---
title: Going back to a previous version
sidebar_position: 10
---

If an update breaks your installation, reinstall the previous version. Your agents, missions and projects stay where they are.

## Before accepting an update

When a newer desktop version opens existing data, Timon asks you to **Update** or **Quit** (**Update anyway** or **Wait** while missions are running) before changing your data or background service. The screen shows the release notes available in the installer. **Quit** leaves your data and installation state intact; reinstall the previous installer to return to that version. Electron may still create its own profile and cache.

**Update** records your approval, prepares the service, then backs up and migrates your data. Keep Timon open while the backup runs; a large copy can take several minutes. If the backup is partial or fails, Timon explains the result. A refused update does not automatically roll back the service or data: follow the displayed instructions before restarting.

### An AppImage you refused to update

When the desktop app installed an update itself (**Install and restart**), the AppImage you launched now holds the new version, under the same name. The version it replaced stays next to it, as a hidden file named `.<name>.previous`, until the new version starts on your data. If the new version asks for your approval, its screen offers **Go back to x.y.z** next to **Quit**: it refuses the update, puts the previous AppImage back under the same name and opens it, on your data and service, which the refused update did not change. If Timon cannot open it, it says so: open the AppImage again. **Quit** removes nothing: opening the AppImage again shows the same screen.

The button is not shown when that file is gone: once an update is approved, at the first start of a version that asks for no approval, or with an AppImage you replaced by hand. Going back then means downloading the older AppImage and following [Linux AppImage](#linux-appimage). If the button reports that the previous version could not be put back, do it by hand: quit Timon, then, here for the default `~/Applications/Timon.AppImage`:

```bash
cd ~/Applications
ls -a                                    # .Timon.AppImage.previous
mv .Timon.AppImage.previous Timon.AppImage
```

Open the AppImage again: it is the previous version.

## Reinstall the previous installer

Install the package of the version you want over the current one, the same way you installed it the first time, then open Timon.

- **Windows**: run the previous `.exe` installer. It replaces the newer version without complaint.
- **macOS**: open the previous `.dmg` and drag Timon to Applications, replacing the existing one, or run the previous `.pkg`.
- **Linux (.deb)**: install the previous package explicitly as a downgrade:

  ```bash
  sudo apt install --allow-downgrades ./Timon-<version>.deb
  # or
  sudo dpkg -i ./Timon-<version>.deb
  ```

On macOS and Linux, Timon moves its background service to the reinstalled version the next time you open it. When going back to 0.1.0 on Linux, the running service does it on its own within a minute of the installation; if the window was open during the switch and stays blank, quit Timon and open it again.

## Restore your data from before the update

From version 0.1.1 on, Timon keeps a copy of your data just before a new version opens them for the first time. Copies now include installed third-party plugins and their local data (`plugins` and `plugins-data`), including whether either folder was absent. The three most recent copies are kept in the `backups` folder of your data directory.

If that copy cannot be made, usually because the disk is full, Timon tells you so and tries again at its next start; free some disk space. When the new version would change your data in a way the previous version cannot read, it does not start at all without the copy, and your data are left untouched.

When you open an older version on data a newer version already used, Timon asks what to do before opening its window:

- **Continue with current data** keeps everything. The older version may ignore what the newer one added. This is the default.
- **Restore data from…** puts back your agents, missions, projects, settings, plugins and their local data as they were in that copy. **Everything done in Timon since that date is lost.** The data you are leaving are kept in `backups/before-restore` until the next restore.

Plugin backups are limited to **1 GiB combined, 100,000 entries and a 30-second processing budget** to keep startup manageable. A slow filesystem operation may take longer to return. If a limit is exceeded, a plugin file cannot be copied, or there is only enough disk space for the database and configuration, Timon explicitly warns that the copy is **partial**. Plugin folders that could not be saved are left unchanged when restoring that copy. A folder recorded as absent is still removed on restoration if it has since been created. Older copies made without plugin support leave both current plugin folders unchanged; keep a separate copy of those folders if you need to restore them yourself. A pending destructive migration still requires a complete copy and refuses to start without one.

Copying and checking plugin data can take a little time during the update. Symbolic links are preserved as links; files outside these folders are not backed up. The safety copy in `backups/before-restore` includes the current plugin folders too. If restoration will replace or remove either plugin folder, a complete safety copy is required; if it cannot be made within the same limits, Timon explains why and cancels restoration without changing your current data. If neither plugin folder will be changed, the database and configuration can still be restored when the safety copy cannot include plugins; the current plugin folders remain untouched.

Nothing is restored unless you click the restore button. If the restore cannot complete, Timon says so and keeps your current data exactly as they were. Version 0.1.0 does not show this question: it opens your current data as they are.

## Linux AppImage

An AppImage cannot be watched for a reinstall, so going back from the AppImage of a newer version to an older AppImage that does not move the service itself (0.1.0) takes a few commands. Quit Timon, then:

```bash
# Find the Timon service of your data directory
systemctl --user list-unit-files 'timon-desktop-*'
# Stop and remove it (replace <id> with the name listed above)
systemctl --user disable --now timon-desktop-<id>.service
rm ~/.config/systemd/user/timon-desktop-<id>.service
systemctl --user daemon-reload
# Tell Timon the service is gone (adapt the path if you use another data directory)
rm ~/.timon/desktop-runtime/installed
```

Then start the previous AppImage. Timon runs its built-in daemon while its window is open, on the same data.

AppImages from 0.1.1 on move the service themselves when you open them: no command is needed.
