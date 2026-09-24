import { spawn } from 'node:child_process';

/** Open a URL in the user's default browser. The spawner is injectable so tests never launch anything. */
export type Spawner = (cmd: string, args: string[]) => void;

const realSpawn: Spawner = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => { /* no opener available — the URL is printed anyway */ });
  child.unref();
};

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, run: Spawner = realSpawn): void {
  if (platform === 'darwin') run('open', [url]);
  else if (platform === 'win32') run('cmd', ['/c', 'start', '', url]);
  else run('xdg-open', [url]);
}
