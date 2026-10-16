import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrivateFile } from './portable-state.mjs';

export const stateDirectory = process.env.ARGON_STATE_DIR || path.join(os.homedir(), 'Library/Application Support/gemini-argon-skill');
const filename = path.join(stateDirectory, 'settings.json');
export const settings = fs.existsSync(filename) ? (checkPrivateFile(filename), JSON.parse(fs.readFileSync(filename, 'utf8'))) : {};
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('本机 settings.json 格式不正确。');
for (const key of ['ARGON_PROXY', 'ARGON_CLAUDE_BIN', 'ARGON_APP_BINARY', 'ARGON_PORT']) {
  if (!process.env[key] && typeof settings[key] === 'string') process.env[key] = settings[key];
}
