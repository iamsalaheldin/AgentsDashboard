// `npm run cmux:launch`: open a dedicated "Mission Control" workspace in cmux that runs
// the production server. Must itself be run from a cmux terminal (cmuxOnly socket mode).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = process.env.CMUX_BUNDLED_CLI_PATH ?? '/Applications/cmux.app/Contents/Resources/bin/cmux';
if (!process.env.CMUX_SURFACE_ID) {
  console.error('Run this from a cmux terminal: cmux only accepts socket commands from processes it started.');
  process.exit(1);
}
if (!existsSync(resolve(root, 'dist/web/index.html'))) {
  console.log('Building the UI first…');
  execFileSync('npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit' });
}
const out = execFileSync(cli, ['new-workspace', '--name', 'Mission Control', '--cwd', root, '--command', 'npm start', '--focus', 'false'], { encoding: 'utf8' });
console.log(out.trim());
console.log(`Mission Control is starting in its own cmux workspace → http://127.0.0.1:${process.env.MC_PORT ?? 4317}`);
