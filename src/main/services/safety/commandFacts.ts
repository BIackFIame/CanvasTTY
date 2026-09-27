import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lexShell, shellQuote, type Segment, type Word } from './shellParse.ts';

/**
 * The hard facts base protection decides on, computed by code from one tool call and the working folder.
 * Nothing is executed and nothing is read except `realpath` of the paths involved. Only the facts a deny rule
 * needs are computed: elevation, a pipe into a shell, download-and-run, disk commands, a fork bomb, and writes or
 * deletes outside the working folder (deleting the folder itself included).
 */

/** One tool call, source-neutral: a shell command or the files a file tool writes. */
export interface ToolAction {
  kind: 'shell' | 'edit' | null;
  /** The shell command; null when none could be read. */
  command: string | null;
  /** The command's own working directory, if the agent said one. */
  commandCwd: string | null;
  /** Paths a file tool writes. */
  paths: string[];
}

export type Where = 'inside' | 'outside' | 'unresolved';
export interface Target {
  raw: string;
  abs: string | null;
  where: Where;
  /** A block device (/dev/disk2, /dev/sda, \\.\PhysicalDrive0). */
  device: boolean;
  /** Names the working folder itself (not through a glob): deleting it is deleting the project. */
  root: boolean;
}

export interface HardFacts {
  elevation: boolean;
  pipeToShell: boolean;
  downloadExec: boolean;
  disk: boolean;
  forkBomb: boolean;
  writesOutside: boolean;
  deletesOutside: boolean;
  /** Absolute targets written outside the working folder (for the temporary-folder advice). */
  outsideWrites: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** realpath of the longest existing ancestor plus the rest (a symlink out of the project resolves outside). */
export function realish(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch { /* go up */ }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
  return path;
}

const DEVICE = /^(?:\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|xvd[a-z]|vd[a-z]|md\d|dm-\d|loop\d|mapper\/)|\\\\\.\\(?:physicaldrive|[a-z]:))/iu;
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$|^(?:nul|con)$/iu;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[A-Za-z]:$|\\\\)/u;

export interface PathContext { root: string; rootReal: string; home: string; temp: string; agentRoots: string[] }

/**
 * `agentRoots`: the agent's own config folders (Claude's ~/.claude or the run's CLAUDE_CONFIG_DIR). Their plan and
 * memory folders belong to the agent, so writing there is not a write outside the project.
 */
export function pathContext(root: string, home = homedir(), agentRoots?: readonly string[]): PathContext {
  return { root, rootReal: realish(resolve(root)), home, temp: tmpdir(), agentRoots: (agentRoots ?? [join(home, '.claude')]).map(dir => realish(resolve(dir))) };
}

const AGENT_SERVICE_DIR = /^(?:plans|projects[\\/][^\\/]+[\\/]memory)(?:[\\/]|$)/u;

/** The path is inside an agent config folder's `plans/` or `projects/<project>/memory/` (already resolved, so no `..`). */
export function isAgentServicePath(abs: string, ctx: PathContext): boolean {
  return ctx.agentRoots.some(dir => {
    const rel = relative(dir, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && AGENT_SERVICE_DIR.test(rel);
  });
}

const HOME_VARS = new Set(['HOME', 'USERPROFILE', 'ENV:USERPROFILE', 'ENV:HOME']);
const TEMP_VARS = new Set(['TMPDIR', 'TEMP', 'TMP', 'ENV:TEMP', 'ENV:TMP']);

/** Expands only what is certain (~, HOME, PWD, TMPDIR); anything else is unresolved. */
function expand(word: Word | string, cwd: string | null, ctx: PathContext): string | null {
  if (typeof word !== 'string' && word.substitution) return null;
  let text = typeof word === 'string' ? word : word.text;
  const vars = typeof word === 'string' ? [] : word.vars;
  for (const name of vars) {
    let value: string | null = null;
    if (HOME_VARS.has(name)) value = ctx.home;
    else if (name === 'PWD' || name === 'ENV:PWD') value = cwd;
    else if (TEMP_VARS.has(name)) value = ctx.temp;
    if (value === null) return null;
    text = text.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])|%${name}%|\\$env:${name.replace(/^ENV:/u, '')}`, 'iu'), value);
  }
  if (typeof word !== 'string' ? word.tilde : text.startsWith('~')) {
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = ctx.home + text.slice(1);
    else return null;
  }
  return text;
}

/**
 * Where a word points. `noFollow`: the operation acts on the last path component itself (rm, unlink, mv of a
 * symlink removes or renames the link, not what it points to), so only the folders above it are resolved.
 */
export function resolveTarget(word: Word | string, cwd: string | null, ctx: PathContext, noFollow = false): Target {
  const raw = typeof word === 'string' ? word : word.text;
  const blank: Target = { raw, abs: null, where: 'unresolved', device: DEVICE.test(raw), root: false };
  const globbed = typeof word !== 'string' && word.glob;
  let text = expand(word, cwd, ctx);
  if (text === null || text === '') return blank;
  if (globbed) {
    // A glob acts on everything under the folder before its first wildcard.
    const first = text.search(/[*?[]/u);
    const cut = text.slice(0, first).lastIndexOf('/');
    text = cut < 0 ? '.' : text.slice(0, cut) || '/';
  }
  if (DEVICE.test(text)) return { ...blank, device: true, where: 'outside', abs: text };
  if (WINDOWS_ABSOLUTE.test(text) && sep === '/') return { ...blank, abs: text, where: 'outside' };
  if (!isAbsolute(text) && cwd === null) return blank;
  const full = resolve(cwd ?? ctx.root, text);
  const abs = noFollow && !/[\\/]$/u.test(text) && basename(full) !== '..' && basename(full) !== '.' && dirname(full) !== full ? join(realish(dirname(full)), basename(full)) : realish(full);
  const rel = relative(ctx.rootReal, abs);
  const inside = rel === '' || !rel.startsWith('..') && !isAbsolute(rel);
  return { raw, abs, where: inside ? 'inside' : 'outside', device: false, root: rel === '' && !globbed };
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'lua', 'luajit', 'rscript', 'tsx', 'ts-node', 'deno', 'bun', 'osascript', 'jshell', 'groovy', 'julia', 'elixir', 'swift']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const EVAL_WORDS = new Set(['eval', 'iex', 'invoke-expression']);
const ELEVATION = new Set(['sudo', 'doas', 'pkexec', 'run0', 'runas', 'gsudo', 'please']);
const WRAPPERS = new Set(['nohup', 'time', 'nice', 'ionice', 'timeout', 'gtimeout', 'stdbuf', 'command', 'builtin', 'exec', 'caffeinate', 'watch', 'chronic', 'unbuffer', 'setsid', 'script']);
const DISK = new Set(['mkfs', 'mke2fs', 'mkswap', 'newfs', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'parted', 'blkdiscard', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition', 'set-disk', 'mdadm', 'lvremove', 'vgremove', 'pvremove', 'cryptsetup', 'asr', 'fdformat', 'gpt']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'certutil', 'bitsadmin', 'lwp-download']);
const DELETERS = new Set(['rm', 'unlink', 'shred', 'trash', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf', 'srm']);
const COPIERS = new Set(['cp', 'install', 'ln', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'mklink', 'ditto', 'rsync']);
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const CREATORS = new Set(['touch', 'mkdir', 'md', 'truncate', 'tee', 'new-item', 'ni', 'set-content', 'add-content', 'ac', 'out-file', 'mkfifo', 'mktemp', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', 'zstd']);
const MODE_CHANGERS = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'attrib', 'icacls', 'takeown']);
/** Git subcommands with no form that changes a repository. Those with both kinds of forms are judged by gitEffect. */
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'merge-base', 'count-objects', 'var', 'help', 'version', 'annotate', 'name-rev', 'show-ref', 'for-each-ref', 'check-ignore', 'ls-remote']);
const WINDOWS_BUILTINS = new Set(['del', 'erase', 'rd', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'format', 'cipher', 'attrib', 'icacls', 'takeown', 'mklink', 'md', 'mkdir', 'rmdir']);

/** A program's name for the tables: basename, lower case, without a Windows executable suffix. */
export function programName(argv0: string): string {
  const name = argv0.replace(/\\/gu, '/').split('/').pop() ?? argv0;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/u, '');
}

const isFlag = (value: string, windows = false): boolean => value.startsWith('-') && value !== '-' || windows && /^\/[A-Za-z?]{1,3}(?::.*)?$/u.test(value);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Acc {
  ctx: PathContext;
  writes: Target[];
  deletes: Target[];
  flags: { elevation: boolean; pipeToShell: boolean; downloadExec: boolean; disk: boolean; forkBomb: boolean };
  depth: number;
  budget: number;
}

interface Stdin { pipeIn: boolean; heredoc: string | null }

function wordOf(text: string): Word { return { text, quoted: false, vars: [], substitution: false, inner: [], glob: false, tilde: false }; }

/** Analyses one shell command string (recursively for `bash -c`, `eval`, substitutions). */
function analyzeText(command: string, cwd: string | null, acc: Acc): string | null {
  if (acc.depth > 4 || --acc.budget < 0) return cwd;
  acc.depth++;
  try {
    const lexed = lexShell(command);
    if (/(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1/u.test(command)) acc.flags.forkBomb = true;
    // PowerShell download-and-run: iex (iwr …), Invoke-Expression (New-Object Net.WebClient).DownloadString(…).
    if (/\b(?:iex|invoke-expression)\b/iu.test(command) && /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\.webclient|start-bitstransfer|curl|wget)\b/iu.test(command)) acc.flags.downloadExec = true;
    let current = cwd;
    const downloadedHere: Target[] = [];
    for (const segment of lexed.segments) current = analyzeSegment(segment, current, acc, downloadedHere);
    return current;
  } finally { acc.depth--; }
}

function analyzeSegment(segment: Segment, cwd: string | null, acc: Acc, downloadedHere: Target[]): string | null {
  const words = [...segment.words];
  // Leading NAME=value assignments.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!.text) && !words[0]!.quoted) words.shift();
  for (const word of segment.words) inspectWord(word, acc);
  for (const redirect of segment.redirects) {
    if (redirect.fdDup || !redirect.target) continue;
    inspectWord(redirect.target, acc);
    if (redirect.op.includes('<<') || !redirect.op.includes('>')) continue;
    if (HARMLESS_DEVICE.test(redirect.target.text)) continue;
    const target = resolveTarget(redirect.target, cwd, acc.ctx);
    if (target.device) { acc.flags.disk = true; continue; }
    acc.writes.push(target);
  }
  if (!words.length) return cwd;
  return analyzeArgv(words, cwd, acc, { pipeIn: segment.pipeIn, heredoc: segment.heredoc }, downloadedHere);
}

function inspectWord(word: Word, acc: Acc): void {
  // A substitution runs its own command.
  if (word.substitution) for (const inner of word.inner) analyzeText(inner, null, acc);
}

function fetchesIn(text: string): boolean {
  return /(?:^|[\s;|&(`])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|http|aria2c|lwp-download)(?:\.exe)?(?=\s|$)/iu.test(text);
}

/** Words → what the command does. Returns the working directory after it (for `cd`). */
function analyzeArgv(argvWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): string | null {
  const argv = argvWords.map(word => word.text);
  const argv0 = argv[0]!;
  const program = programName(argv0);
  const args = argv.slice(1);
  const argWords = argvWords.slice(1);
  const innerFetch = argvWords.some(word => word.inner.some(inner => fetchesIn(inner)));

  // An argv0 that is itself a substitution or a variable: nobody can tell what runs.
  if (argvWords[0]!.substitution || argvWords[0]!.vars.length) {
    if (innerFetch) acc.flags.downloadExec = true;
    return cwd;
  }

  if (ELEVATION.has(program) || program === 'su' || (program === 'start-process' && args.some(arg => /^-verb$/iu.test(arg)) && args.some(arg => /^runas$/iu.test(arg)))) {
    acc.flags.elevation = true;
    const inner = program === 'su' ? args.indexOf('-c') : argWords.findIndex(word => !isFlag(word.text));
    if (program === 'su' && inner >= 0 && args[inner + 1]) analyzeText(args[inner + 1]!, cwd, acc);
    else if (program !== 'su' && inner >= 0) analyzeArgv(argWords.slice(inner), cwd, acc, stdin, downloadedHere);
    return cwd;
  }

  // Wrappers run their argument as a command.
  if (WRAPPERS.has(program) || program === 'env' && args.some(arg => !arg.startsWith('-') && !arg.includes('=')) || program === 'xargs') {
    if (program === 'command' && (args[0] === '-v' || args[0] === '-V')) return cwd;
    const takesValue = new Set(['-n', '-u', '-s', '-k', '-i', '-o', '-e', '-c', '-C', '-I', '-L', '-P', '-d', '--signal', '--kill-after', '--adjustment', '--unset', '--chdir', '--max-args', '--max-procs', '--replace', '--delimiter']);
    let i = 0;
    for (; i < argWords.length; i++) {
      const text = argWords[i]!.text;
      if (program === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)) continue;
      if (text.startsWith('-')) { if (takesValue.has(text) && program !== 'xargs' || program === 'xargs' && ['-n', '-P', '-I', '-L', '-d', '-s', '-E'].includes(text)) i++; continue; }
      if ((program === 'timeout' || program === 'gtimeout') && /^\d/u.test(text)) continue;
      if (program === 'nice' && /^-?\d+$/u.test(text)) continue;
      break;
    }
    if (i >= argWords.length) return cwd;
    return analyzeArgv(argWords.slice(i), cwd, acc, program === 'xargs' ? { pipeIn: false, heredoc: null } : stdin, downloadedHere);
  }

  if (program === 'cd' || program === 'pushd' || program === 'chdir' || program === 'set-location' || program === 'sl') {
    const dest = argWords.filter(word => !isFlag(word.text))[0];
    if (!dest) return acc.ctx.home;
    if (dest.text === '-') return null;
    return resolveTarget(dest, cwd, acc.ctx).abs;
  }
  if (program === 'popd') return null;

  if (EVAL_WORDS.has(program)) {
    const generated = program !== 'eval' || argWords.some(word => word.substitution || word.vars.length) || stdin.pipeIn;
    if (generated) {
      if (stdin.pipeIn || innerFetch) acc.flags.pipeToShell = true;
      return cwd;
    }
    return analyzeText(args.join(' '), cwd, acc);
  }

  if (program === 'source' || program === '.') {
    const file = argWords.filter(word => !isFlag(word.text))[0];
    if (file?.substitution && innerFetch) acc.flags.downloadExec = true;
    else if (file) runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }

  if (SHELLS.has(program) || POWERSHELLS.has(program) || program === 'cmd') return runShell(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);
  if (INTERPRETERS.has(program)) return runInterpreter(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);

  // A program named by path: running a file this command just downloaded.
  if (/[\\/]/u.test(argv0)) runScript(resolveTarget(argvWords[0]!, cwd, acc.ctx), acc, downloadedHere);

  classifyProgram(program, argWords, cwd, acc, stdin, downloadedHere);
  return cwd;
}

function runScript(file: Target, acc: Acc, downloadedHere: Target[]): void {
  if (downloadedHere.some(item => item.abs && item.abs === file.abs)) acc.flags.downloadExec = true;
}

function runShell(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  const powershell = POWERSHELLS.has(program);
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    const inline = program === 'cmd' ? /^\/[ck]$/iu.test(text) : powershell ? /^-(?:c|command)$/iu.test(text) : /^-[a-z]*c[a-z]*$/u.test(text) && !text.startsWith('--');
    if (inline) {
      const rest = program === 'cmd' || powershell ? args.slice(i + 1).join(' ') : args[i + 1];
      if (innerFetch) acc.flags.downloadExec = true;
      if (rest !== undefined && !(argWords[i + 1]?.substitution && program !== 'cmd')) analyzeText(rest, cwd, acc);
      return cwd;
    }
    if (powershell && /^-(?:f|file)$/iu.test(text)) {
      const file = argWords[i + 1];
      if (file) runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
      return cwd;
    }
    if (text.toLowerCase() === '-s' && !powershell) break;
    if (isFlag(text, program === 'cmd')) { if (/^--?(?:rcfile|init-file|o)$/u.test(text)) i++; continue; }
    if (powershell && /^-/u.test(text)) continue;
    // The first operand is a script file; the rest are its arguments. `bash <(curl …)`: a download run as a script.
    const file = argWords[i]!;
    if (file.substitution) { if (innerFetch) acc.flags.downloadExec = true; return cwd; }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }
  // No script: the shell reads stdin.
  if (stdin.pipeIn) acc.flags.pipeToShell = true;
  else if (stdin.heredoc !== null) analyzeText(stdin.heredoc, cwd, acc);
  return cwd;
}

function runInterpreter(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  if (args.length === 1 && /^(?:--?version|-v|-V)$/u.test(args[0]!)) return cwd;
  const python = program.startsWith('python') || program.startsWith('pypy');
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    if (python && text === '-m') return cwd;
    if (/^(?:-c|-e|--eval|-p|--print|-r|-E)$/u.test(text) || program === 'deno' && text === 'eval' || program === 'osascript' && text === '-e') {
      if (innerFetch) acc.flags.downloadExec = true;
      if (argWords[i + 1] && fetchesIn(args[i + 1]!) && /\b(?:exec|eval|system|spawn|child_process|subprocess|os\.system)\b/u.test(args[i + 1]!)) acc.flags.downloadExec = true;
      return cwd;
    }
    if (text.startsWith('-')) { if (/^(?:-W|-X|--require|-r|--import|--loader|-I)$/u.test(text)) i++; continue; }
    if ((program === 'deno' || program === 'bun') && ['run', 'x', 'test', 'task', 'check', 'lint', 'fmt', 'compile', 'build', 'install', 'add'].includes(text)) continue;
    const file = argWords[i]!;
    if (file.substitution) { if (innerFetch) acc.flags.downloadExec = true; return cwd; }
    if (/^https?:\/\//iu.test(file.text)) { acc.flags.downloadExec = true; return cwd; }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }
  if (stdin.pipeIn) acc.flags.pipeToShell = true;
  return cwd;
}

function classifyProgram(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const windows = WINDOWS_BUILTINS.has(program) || args.some(arg => /^\/[sq]$/iu.test(arg));
  const positional = argWords.filter(word => !isFlag(word.text, windows));
  const target = (word: Word | string, noFollow = false): Target => resolveTarget(word, cwd, acc.ctx, noFollow);
  const sub = positional[0]?.text;

  // Disks.
  if (DISK.has(program) || program.startsWith('mkfs') || program.startsWith('newfs')) { acc.flags.disk = true; return; }
  if (program === 'diskutil') {
    if (/^(?:erase|zero|random|secure|partition|reformat|apfs|cs|appleraid|ar|resetfusion|repairdisk|mergepartitions|splitpartition|resizevolume|addpartition)/iu.test(sub ?? '') || /^(?:deletecontainer|deletevolume|erasevolume)$/iu.test(positional[1]?.text ?? '')) acc.flags.disk = true;
    return;
  }
  if (program === 'format' && positional.some(word => /^[A-Za-z]:\\?$/u.test(word.text))) { acc.flags.disk = true; return; }
  if (program === 'cipher' && args.some(arg => /^\/w/iu.test(arg))) { acc.flags.disk = true; return; }
  if (program === 'dd') {
    for (const arg of args) {
      const m = /^of=(.*)$/u.exec(arg);
      if (!m) continue;
      const t = target(m[1]!);
      if (t.device || /^\/dev\//u.test(m[1]!) && !HARMLESS_DEVICE.test(m[1]!)) acc.flags.disk = true;
      else acc.writes.push(t);
    }
    return;
  }

  if (program === 'git') { classifyGit(argWords, cwd, acc); return; }
  // `uv run X`, `bundle exec X` and friends run their argument as a command.
  if ((['uv', 'poetry', 'pipenv', 'conda'].includes(program) && sub === 'run') || (program === 'bundle' && sub === 'exec')) {
    const start = argWords.findIndex(word => word.text === sub);
    const inner = argWords.slice(start + 1).findIndex(word => !word.text.startsWith('-'));
    if (inner >= 0) analyzeArgv(argWords.slice(start + 1 + inner), cwd, acc, stdin, downloadedHere);
    return;
  }

  // Deleting.
  if (DELETERS.has(program)) {
    for (const word of positional.filter(word => !/^-/u.test(word.text))) {
      const t = target(word, true);
      if (program === 'shred' && t.device) acc.flags.disk = true;
      acc.deletes.push(t);
    }
    return;
  }
  if (program === 'find') {
    const starts: Word[] = [];
    let i = 0;
    for (; i < argWords.length && !/^[-(!]/u.test(argWords[i]!.text); i++) starts.push(argWords[i]!);
    if (!starts.length) starts.push(wordOf('.'));
    const exec = args.findIndex(arg => /^-(?:exec|execdir|ok|okdir)$/u.test(arg));
    const printTo = args.findIndex(arg => /^-f(?:print0?|printf|ls)$/u.test(arg));
    if (printTo >= 0 && args[printTo + 1]) acc.writes.push(target(args[printTo + 1]!));
    // The start folders are the scope of the deletion, not deleted themselves.
    if (args.includes('-delete')) { for (const start of starts) acc.deletes.push({ ...target(start), root: false }); return; }
    if (exec >= 0) {
      const end = args.findIndex((arg, index) => index > exec && (arg === ';' || arg === '+' || arg === '\\;'));
      const inner = argWords.slice(exec + 1, end < 0 ? undefined : end).map(word => word.text === '{}' ? starts[0]! : word);
      if (inner.length) analyzeArgv(inner, cwd, acc, { pipeIn: false, heredoc: null }, downloadedHere);
    }
    return;
  }

  // Writing.
  if (COPIERS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    const dest = files.length > 1 ? files[files.length - 1]! : program === 'install' && args.includes('-d') ? files[0] : undefined;
    // rsync to `host:path` is a remote copy, not a local write.
    if (dest && !(program === 'rsync' && /^[^/\\]*:/u.test(dest.text) && !/^[A-Za-z]:[\\/]/u.test(dest.text))) acc.writes.push(target(dest));
    return;
  }
  if (MOVERS.has(program)) {
    // A move changes both ends (a moved symlink is the link itself; the destination may be a folder it enters).
    const files = positional.filter(word => !/^-/u.test(word.text));
    files.forEach((word, index) => acc.writes.push(target(word, index < files.length - 1)));
    return;
  }
  if (CREATORS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    if (program === 'truncate') { const size = args.findIndex(arg => arg === '-s'); if (size >= 0) files.splice(files.findIndex(word => word.text === args[size + 1]), 1); }
    if (program === 'mktemp') acc.writes.push(files.length ? target(files[0]!) : target(acc.ctx.temp));
    else for (const word of files) acc.writes.push(target(word));
    return;
  }
  if (MODE_CHANGERS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text)).slice(program === 'attrib' || program === 'icacls' || program === 'takeown' ? 0 : 1);
    for (const word of files) acc.writes.push(target(word));
    return;
  }
  if (program === 'sed' || program === 'gsed' || program === 'perl') {
    if (!args.some(arg => /^-[a-zA-Z]*i/u.test(arg) || arg.startsWith('--in-place'))) return;
    const explicitScript = args.some(arg => arg === '-e' || arg === '-f' || arg.startsWith('--expression'));
    for (const word of positional.filter(word => !/^-/u.test(word.text)).slice(explicitScript ? 0 : 1)) acc.writes.push(target(word));
    return;
  }
  if (program === 'tar' || program === 'bsdtar' || program === 'unzip' || program === '7z' || program === 'unrar') {
    const extract = program === 'unzip' || program === 'unrar' || program === '7z' && sub === 'x' || /^-?[a-zA-Z]*x/u.test(args[0] ?? '') || args.includes('--extract') || args.includes('-x');
    const dirFlag = args.findIndex(arg => arg === '-C' || arg === '--directory' || arg === '-d' || arg.startsWith('-o'));
    const dest = dirFlag >= 0 ? (args[dirFlag]!.startsWith('-o') && args[dirFlag]!.length > 2 ? args[dirFlag]!.slice(2) : args[dirFlag + 1]) : '.';
    if (extract && dest) acc.writes.push(target(dest));
    const fileFlag = args.findIndex(arg => /^-?[a-zA-Z]*f$/u.test(arg) || arg === '--file');
    if (!extract && fileFlag >= 0 && args[fileFlag + 1]) acc.writes.push(target(args[fileFlag + 1]!));
    return;
  }
  if (FETCHERS.has(program)) classifyFetch(program, argWords, cwd, acc, downloadedHere);
}

/** Where a download lands: `-o file`, `-O` (the URL's name), wget's default. */
function classifyFetch(program: string, argWords: Word[], cwd: string | null, acc: Acc, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const target = (word: Word | string): Target => resolveTarget(word, cwd, acc.ctx);
  const urls = args.filter(arg => /^[a-z]+:\/\//iu.test(arg) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/iu.test(arg));
  const land = (t: Target): void => { acc.writes.push(t); downloadedHere.push(t); };
  const urlName = (): string => (urls[0] ?? '').replace(/[?#].*$/u, '').split('/').pop() || 'index.html';
  let explicit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = argWords[i + 1];
    if ((arg === '-o' || arg === '--output' || arg === '-O' && program === 'wget' || arg === '--output-document' || /^-outfile$/iu.test(arg) || arg === '-P' || arg === '--directory-prefix') && next) {
      explicit = true;
      if (next.text !== '-') land(target(next));
      i++; continue;
    }
    if (arg === '-O' || arg === '--remote-name' || arg === '--remote-name-all') { explicit = true; land(target(urlName())); }
  }
  if (program === 'wget' && !explicit && !args.some(arg => arg === '-O-' || arg === '-qO-' || arg === '--spider')) land(target(urlName()));
}

function classifyGit(argWords: Word[], cwd: string | null, acc: Acc): void {
  const args = argWords.map(word => word.text);
  let i = 0, dir = cwd;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C') { dir = args[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null; i++; continue; }
    // The repository another --work-tree or --git-dir names is changed exactly like one -C names.
    if (arg === '--work-tree' || arg === '--git-dir') { dir = args[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null; i++; continue; }
    if (arg.startsWith('--work-tree=') || arg.startsWith('--git-dir=')) { dir = resolveTarget(arg.slice(arg.indexOf('=') + 1), cwd, acc.ctx).abs; continue; }
    if (arg === '-c' || arg === '--namespace' || arg === '--exec-path') { i++; continue; }
    if (arg.startsWith('-')) continue;
    break;
  }
  const sub = args[i] ?? '';
  const restWords = argWords.slice(i + 1);
  const rest = restWords.map(word => word.text);
  if (GIT_READ.has(sub)) return;
  // `git -C <folder outside>` that changes or cleans that repository changes files outside.
  const other = dir !== cwd && dir !== null ? resolveTarget(dir, cwd, acc.ctx) : null;
  const elsewhere = other?.where === 'outside' ? { ...other, root: false } : null;
  const effect = gitEffect(sub, rest);
  if (effect === 'read') return;
  if (effect === 'delete') {
    if (elsewhere) acc.deletes.push(elsewhere);
    return;
  }
  if (sub === 'clean' || sub === 'rm') {
    for (const word of restWords.filter(word => !word.text.startsWith('-'))) acc.deletes.push(resolveTarget(word, dir, acc.ctx, true));
    if (elsewhere) acc.deletes.push(elsewhere);
    return;
  }
  if (sub === 'clone') {
    const positional = restWords.filter(word => !word.text.startsWith('-'));
    const url = positional[0]?.text ?? '';
    acc.writes.push(resolveTarget(positional[1] ?? wordOf(url.replace(/[?#].*$/u, '').replace(/\.git$/u, '').split(/[/:]/u).pop() || 'repo'), dir, acc.ctx));
    return;
  }
  if (sub === 'worktree' && rest[0] === 'add') {
    const dest = restWords.slice(1).find(word => !word.text.startsWith('-'));
    if (dest) acc.writes.push(resolveTarget(dest, dir, acc.ctx));
    return;
  }
  if (elsewhere) acc.writes.push(elsewhere);
}

/** Flags whose next word is their value, per subcommand, so a value is never taken for a name. */
const GIT_VALUE_FLAGS: Record<string, readonly string[]> = {
  branch: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--column'],
  tag: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--column', '-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup'],
  config: ['-f', '--file', '--blob', '--type', '--default', '--comment']
};

/**
 * For the subcommands that have read-only and changing forms: whether this form reads, changes ('write') or
 * deletes ('delete': saved stashes, branches, tags, remotes, reflog entries) the repository; null for any other
 * subcommand (then the caller's own rules apply). Parsed only; nothing is run.
 */
function gitEffect(sub: string, rest: readonly string[]): 'read' | 'write' | 'delete' | null {
  const values = new Set(GIT_VALUE_FLAGS[sub] ?? []);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (values.has(arg)) { i++; continue; }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const has = (...flags: string[]): boolean => rest.some(arg => flags.some(flag => arg === flag || flag.startsWith('--') && arg.startsWith(`${flag}=`)));
  switch (sub) {
    case 'stash': {
      const action = positional[0];
      if (action === 'list' || action === 'show') return 'read';
      return action === 'drop' || action === 'clear' ? 'delete' : 'write';
    }
    case 'pull': return 'write';
    case 'fetch':
    case 'push': return has('--dry-run') ? 'read' : 'write';
    case 'branch':
      if (has('-d', '-D', '--delete')) return 'delete';
      if (has('-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-f', '--force', '-t', '--track')) return 'write';
      return positional.length > 0 && !has('-l', '--list') ? 'write' : 'read';
    case 'tag':
      if (has('-d', '--delete')) return 'delete';
      if (has('-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-f', '--force', '-m', '--message', '-F', '--file')) return 'write';
      return positional.length > 0 && !has('-l', '--list', '-v', '--verify') ? 'write' : 'read';
    case 'config': {
      const action = positional[0];
      if (action === 'get' || action === 'list') return 'read';
      if (action === 'set' || action === 'unset' || action === 'rename-section' || action === 'remove-section' || action === 'edit') return 'write';
      if (has('--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit')) return 'write';
      if (has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list')) return 'read';
      return positional.length >= 2 ? 'write' : 'read';
    }
    case 'remote': {
      const action = positional[0];
      if (action === undefined || action === 'show' || action === 'get-url') return 'read';
      return action === 'remove' || action === 'rm' ? 'delete' : 'write';
    }
    case 'reflog': {
      const action = positional[0];
      return action === 'expire' || action === 'delete' ? 'delete' : 'read';
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The whole call
// ---------------------------------------------------------------------------

/** Converts an argv array (Codex style `["bash","-lc","…"]`) into one command string. */
export function commandFromArgv(argv: readonly string[]): string { return argv.map(shellQuote).join(' '); }

export function analyzeAction(action: ToolAction, root: string, options: { home?: string; agentRoots?: readonly string[] } = {}): HardFacts {
  const ctx = pathContext(root, options.home, options.agentRoots);
  const acc: Acc = { ctx, writes: [], deletes: [], depth: 0, budget: 64, flags: { elevation: false, pipeToShell: false, downloadExec: false, disk: false, forkBomb: false } };
  const commandCwd = action.commandCwd ? resolveTarget(action.commandCwd, ctx.rootReal, ctx) : null;
  const cwd = commandCwd ? commandCwd.abs : ctx.rootReal;
  if (action.kind === 'shell' && action.command) analyzeText(action.command, cwd, acc);
  else if (action.kind === 'edit') acc.writes.push(...action.paths.map(path => resolveTarget(path, cwd, ctx)));
  const outside = acc.writes.filter(t => t.where === 'outside' && !t.device && !(t.abs && isAgentServicePath(t.abs, ctx)));
  return {
    ...acc.flags,
    writesOutside: outside.length > 0,
    // Deleting the working folder itself counts as deleting outside it.
    deletesOutside: acc.deletes.some(t => t.where === 'outside' || t.root),
    outsideWrites: outside.map(t => t.abs).filter((abs): abs is string => abs !== null)
  };
}
