// SPDX-License-Identifier: MIT
import { basename, join } from 'node:path';
import { SyncTransportError } from './transport.mjs';

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** Create scheduler files as a plan only. This function never invokes the host scheduler. */
export function planScheduler({ platform, paths, intervalMin = 30 } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !paths || typeof paths.binPath !== 'string' || typeof paths.stateDir !== 'string'
      || !Number.isSafeInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) throw new SyncTransportError('E_STATE_INVALID');
  let files;
  if (platform === 'darwin') {
    const target = join(paths.launchAgentsDir ?? join(paths.stateDir, 'scheduler'), 'com.brainatlas.sync.plist');
    const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>org.brainatlas.sync</string>\n<key>ProgramArguments</key><array><string>${xml(paths.binPath)}</string><string>sync</string><string>run</string></array>\n<key>StartInterval</key><integer>${intervalMin * 60}</integer>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`;
    files = [{ path: target, contents }];
  } else {
    const root = paths.systemdUserDir ?? join(paths.configDir ?? paths.stateDir, 'systemd', 'user');
    const command = `"${paths.binPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" sync run`;
    files = [
      { path: join(root, 'brainatlas-sync.service'), contents: `[Unit]\nDescription=BrainAtlas sync\n\n[Service]\nType=oneshot\nExecStart=${command}\n` },
      { path: join(root, 'brainatlas-sync.timer'), contents: `[Unit]\nDescription=Run BrainAtlas sync periodically\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=${intervalMin}min\nPersistent=true\nUnit=brainatlas-sync.service\n\n[Install]\nWantedBy=timers.target\n` },
    ];
  }
  const uninstall = files.map((file) => file.path);
  const text = files.map((file) => `# ${basename(file.path)}\n${file.contents}`).join('\n');
  return { platform, intervalMin, text, files, uninstall, installManifest: { files: [...uninstall] } };
}

export function planSchedulerUninstall({ platform, paths } = {}) {
  const plan = planScheduler({ platform, paths });
  return { platform, files: plan.uninstall, text: `Remove these scheduler files:\n${plan.uninstall.join('\n')}` };
}
