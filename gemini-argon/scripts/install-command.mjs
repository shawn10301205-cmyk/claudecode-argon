import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { ensurePrivateDirectory } from '../runtime/scripts/portable-state.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const owner = stat => !process.getuid || stat.uid === process.getuid();
function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('安装路径必须是无换行符的绝对路径。');
  return path.resolve(value);
}
function lstat(filename) { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

function packageFiles(root) {
  const bytes = fs.readFileSync(path.join(root, 'MANIFEST.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.package !== 'gemini-argon' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Skill 文件清单无效。');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || path.isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw new Error('Skill 文件清单包含不安全路径。');
    seen.add(file.path); let current = root;
    for (const part of file.path.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('安装源不能包含符号链接。'); }
    if (!fs.statSync(current).isFile() || hash(fs.readFileSync(current)) !== file.sha256) throw new Error('Skill 文件校验失败，未安装命令。');
  }
  if (!seen.has('scripts/argon.mjs') || !seen.has('runtime/package-lock.json')) throw new Error('Skill 缺少启动入口或依赖锁定文件。');
  return { bytes, files: manifest.files, id: hash(bytes) };
}

export function pathBlock(binDirectory) {
  return `# >>> gemini-argon-skill PATH >>>\ncase ":$PATH:" in\n  *${shellQuote(`:${binDirectory}:`)}*) ;;\n  *) export PATH=${shellQuote(binDirectory)}:"$PATH" ;;\nesac\n# <<< gemini-argon-skill PATH <<<\n`;
}
function profilePlan(profile, binDirectory, requested, onPath) {
  if (!requested || onPath) return { change: false };
  const stat = lstat(profile);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || !owner(stat) || stat.size > 2 * 1024 * 1024)) throw new Error('Shell 配置不是本人普通文件，拒绝修改。');
  const text = stat ? fs.readFileSync(profile, 'utf8') : '';
  const block = pathBlock(binDirectory);
  if (text.includes(block)) return { change: false, alreadyConfigured: true };
  if (text.includes('gemini-argon-skill PATH')) throw new Error('已有不同的 Argon PATH 配置，请先确认，不自动覆盖。');
  return { change: true, text, block, stat };
}
function updateProfile(profile, plan) {
  if (!plan.change) return null;
  const backup = plan.stat ? `${profile}.gemini-argon-${hash(Buffer.from(plan.text)).slice(0, 12)}.bak` : null;
  if (backup) {
    const prior = lstat(backup);
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || !owner(prior) || (prior.mode & 0o077) || fs.readFileSync(backup, 'utf8') !== plan.text)) throw new Error('已有备份不安全或内容不匹配，拒绝覆盖。');
    if (!prior) { fs.copyFileSync(profile, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); }
  }
  const descriptor = fs.openSync(profile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || !owner(current) || (plan.stat && (current.ino !== plan.stat.ino || current.dev !== plan.stat.dev)) || (!plan.stat && current.size !== 0) || fs.readFileSync(profile, 'utf8') !== plan.text) throw new Error('Shell 配置在安装期间已变化，拒绝追加。');
    fs.writeFileSync(descriptor, `${plan.text && !plan.text.endsWith('\n') ? '\n' : ''}${plan.block}`);
  } finally { fs.closeSync(descriptor); }
  return backup;
}
async function installDependencies(release) {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: path.join(release, 'runtime'), stdio: 'inherit' });
    child.once('error', () => reject(new Error('无法启动 npm；未创建快捷命令。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('固定目录内的依赖安装失败；未创建快捷命令。')));
  });
  const require = createRequire(path.join(release, 'runtime/package.json'));
  const modules = fs.realpathSync(path.join(release, 'runtime/node_modules')) + path.sep;
  for (const name of ['ajv', 'ajv-formats']) if (!fs.realpathSync(require.resolve(name)).startsWith(modules)) throw new Error('固定目录缺少已安装依赖；未创建快捷命令。');
}

export async function installCommand({ skillDirectory, stateDirectory, binDirectory = path.join(os.homedir(), '.local/bin'), configurePath = false, profile = path.join(os.homedir(), '.zprofile'), nodeBinary = process.execPath, searchPath = process.env.PATH || '', dependencyInstaller = installDependencies } = {}) {
  skillDirectory = safePath(skillDirectory); stateDirectory = safePath(stateDirectory); binDirectory = safePath(binDirectory); profile = safePath(profile); nodeBinary = safePath(nodeBinary);
  if (configurePath && process.env.SHELL && !process.env.SHELL.endsWith('/zsh')) throw new Error('自动 PATH 配置目前仅针对 zsh；其他 shell 请手动配置，不修改其启动文件。');
  const source = packageFiles(skillDirectory);
  const release = path.join(stateDirectory, 'releases', source.id);
  const command = path.join(binDirectory, 'claude-argon');
  const launcher = `#!/bin/sh\n# gemini-argon-skill launcher v1\nexport ARGON_STATE_DIR=${shellQuote(stateDirectory)}\nexec ${shellQuote(nodeBinary)} ${shellQuote(path.join(release, 'scripts/argon.mjs'))} chat "$@"\n`;
  for (const folder of searchPath.split(path.delimiter).filter(Boolean)) {
    const other = path.join(path.resolve(folder), 'claude-argon');
    if (other !== command && lstat(other)) throw new Error(`PATH 中已有同名命令，未修改任何已有入口：${other}`);
  }
  const existing = lstat(command);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || !owner(existing) || (existing.mode & 0o022) || fs.readFileSync(command, 'utf8') !== launcher)) throw new Error(`claude-argon 已存在且不属于本次安装，拒绝覆盖：${command}`);
  const binStat = lstat(binDirectory);
  if (binStat && (!binStat.isDirectory() || binStat.isSymbolicLink() || !owner(binStat) || (binStat.mode & 0o022))) throw new Error('命令目录不安全，未修改。');
  fs.accessSync(nodeBinary, fs.constants.X_OK);
  const onPath = searchPath.split(path.delimiter).filter(Boolean).some(folder => path.resolve(folder) === binDirectory);
  const plan = profilePlan(profile, binDirectory, configurePath, onPath);
  ensurePrivateDirectory(stateDirectory);
  const lock = path.join(stateDirectory, '.command-install.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('另一次快捷命令安装尚未完成；请确认后再试。'); }
  let staging;
  try {
    const releases = path.join(stateDirectory, 'releases'); ensurePrivateDirectory(releases);
    if (!lstat(release)) {
      staging = fs.mkdtempSync(path.join(releases, '.install-'));
      for (const file of source.files) {
        const target = path.join(staging, file.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const bytes = fs.readFileSync(path.join(skillDirectory, file.path));
        if (hash(bytes) !== file.sha256) throw new Error('安装源在复制时已变化；未创建快捷命令。');
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      fs.writeFileSync(path.join(staging, 'MANIFEST.json'), source.bytes, { flag: 'wx', mode: 0o600 });
      await dependencyInstaller(staging);
      if (lstat(release)) throw new Error('安装目录在操作期间已变化，停止安装。');
      fs.renameSync(staging, release); staging = null;
    } else {
      const stat = fs.lstatSync(release);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat) || (stat.mode & 0o077) || packageFiles(release).id !== source.id) throw new Error('已有固定运行目录校验失败，不覆盖现有安装。');
    }
    if (!binStat) fs.mkdirSync(binDirectory, { recursive: true, mode: 0o755 });
    const check = fs.lstatSync(binDirectory);
    if (!check.isDirectory() || check.isSymbolicLink() || !owner(check) || (check.mode & 0o022)) throw new Error('命令目录在操作期间已变化，停止安装。');
    let created = false;
    if (!existing) { fs.writeFileSync(command, launcher, { flag: 'wx', mode: 0o755 }); created = true; }
    else fs.accessSync(command, fs.constants.X_OK);
    const backup = updateProfile(profile, plan);
    return { installed: true, created, command, runtimeDirectory: release, originalPackageMayBeMoved: true, onCurrentPath: onPath, pathConfiguredForNewZsh: onPath || plan.change || !!plan.alreadyConfigured, profileChanged: plan.change, profileBackup: backup, activateCurrentTerminal: onPath ? null : `export PATH=${shellQuote(binDirectory)}:"$PATH"`, next: onPath ? 'claude-argon' : plan.change || plan.alreadyConfigured ? '重新打开终端后运行 claude-argon；当前终端也可执行 activateCurrentTerminal。' : '命令已安装；将命令目录加入 PATH，或使用 command 中的绝对路径。' };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}
