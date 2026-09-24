/* Writes the Claude Code plugin files (E2). Usage: npm run build:plugin */
import fs from 'node:fs';
import path from 'node:path';
import { pluginFiles } from '../src/setup/plugin-files.js';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
for (const [rel, text] of Object.entries(pluginFiles(version))) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`wrote ${rel}`);
}
