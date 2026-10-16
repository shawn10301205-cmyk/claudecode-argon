import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory) || [path.parse(resolved).root, os.homedir(), path.join(os.homedir(), 'Desktop')].includes(resolved) || /(?:^|\/)\.(?:codex|claude)(?:\/|$)/.test(resolved)) throw new Error('状态目录必须是专用绝对路径，不能指向主目录、桌面或智能体安装目录。');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('状态目录必须属于当前用户，不能是符号链接。');
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function checkPrivateFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error('私有配置必须仅当前用户可读写，且不能是符号链接。');
  return stat;
}
