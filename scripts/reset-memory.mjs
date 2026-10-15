import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, resolveDataPath } from '../src/config.js';
import { Database } from '../src/db/index.js';

// Run with: node --env-file-if-exists=.env --import tsx scripts/reset-memory.mjs --dry-run
// Replace --dry-run with --execute after stopping the service. No backup is created.
const TABLES = ['messages','memories','topics','link_reads','reports','deliveries','send_tasks'];
const SHARED_DOCUMENTS = '/opt/snowluma-docker/data/qq-bot-documents';
const MANAGED_DOCUMENT = /^doc-[0-9a-f]{32}$/;

function within(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Deletion target is outside its allowed runtime directory');
  }
}

async function checkedPath(target, parent, kind, missingAllowed = false) {
  within(parent, target);
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error?.code === 'ENOENT' && missingAllowed) return false; throw error; }
  if (stat.isSymbolicLink() || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) {
    throw new Error('Refusing a symlink or unexpected reset target type');
  }
  const resolvedParent = await fs.realpath(parent);
  if (resolvedParent !== path.resolve(parent)) throw new Error('Refusing a symlinked runtime parent');
  within(resolvedParent, await fs.realpath(target));
  return true;
}

function stoppedService(root) {
  if (root !== '/opt/qq-group-bot') return;
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'qq-group-bot'], {stdio: 'ignore'});
    throw new Error('Stop qq-group-bot before deleting its memory');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 3)) throw error;
  }
}

/** Read-only preflight: inspect every target before any database or filesystem mutation. */
export async function prepareMemoryReset(projectRoot, cfg) {
  const root = path.resolve(projectRoot);
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Refusing a symlinked project root');
  const databasePath = resolveDataPath(root, cfg.database.path);
  await checkedPath(databasePath, root, 'file');
  const runtimeRoot = path.dirname(databasePath);
  const directories = [];
  for (const [category, configured] of [['logs', cfg.logging.dir], ['reports', cfg.reports.outputDir]]) {
    const target = resolveDataPath(root, configured);
    // A misconfigured log directory must never erase the DB, source, fonts,
    // login state or the separately sanitized diagnostics store.
    within(runtimeRoot, target);
    const relative = path.relative(runtimeRoot, target).split(path.sep)[0];
    if (['diagnostics','fonts','login','credentials','memory-reset-backups'].includes(relative)) throw new Error('Reset directory overlaps protected runtime state');
    if (await checkedPath(target, runtimeRoot, 'directory', true)) directories.push({category, target, parent: runtimeRoot});
  }
  const backups = path.join(runtimeRoot, 'memory-reset-backups');
  if (await checkedPath(backups, runtimeRoot, 'directory', true)) directories.push({category: 'memoryBackups', target: backups, parent: runtimeRoot});

  const documents = [];
  const documentRoot = resolveDataPath(root, cfg.documents?.outputDir ?? 'data/documents');
  const externalDocuments = root === '/opt/qq-group-bot' && documentRoot === SHARED_DOCUMENTS;
  if (externalDocuments) {
    try {
      const stat = await fs.lstat(documentRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(documentRoot) !== SHARED_DOCUMENTS) {
        throw new Error('Refusing an unexpected shared document directory');
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  } else {
    within(runtimeRoot, documentRoot);
    await checkedPath(documentRoot, runtimeRoot, 'directory', true);
  }
  try {
    for (const entry of await fs.readdir(documentRoot, {withFileTypes: true})) {
      if (!MANAGED_DOCUMENT.test(entry.name)) continue;
      const target = path.join(documentRoot, entry.name);
      await checkedPath(target, documentRoot, 'directory');
      documents.push({category: 'documentArtifacts', target, parent: documentRoot});
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const allDirectories = [...directories, ...documents];
  for (let i = 0; i < allDirectories.length; i++) {
    for (let j = i + 1; j < allDirectories.length; j++) {
      const a = allDirectories[i].target;
      const b = allDirectories[j].target;
      const relative = path.relative(a, b);
      if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)) || (!path.relative(b, a).startsWith('..') && !path.isAbsolute(path.relative(b, a)))) {
        throw new Error('Reset targets overlap');
      }
    }
  }
  const archives = [];
  if (root === '/opt/qq-group-bot') {
    const archive = '/tmp/qqbot-data.tgz';
    if (await checkedPath(archive, '/tmp', 'file', true)) {
      const listing = execFileSync('tar', ['-tzf', archive], {encoding:'utf8', stdio:['ignore','pipe','ignore']});
      if (!listing.split('\n').some(entry => /^data\/bot\.db(?:$|-)/.test(entry))) throw new Error('Unexpected memory archive contents');
      archives.push({category: 'legacyArchives', target: archive, parent: '/tmp'});
    }
  }
  const reader = new DatabaseSync(databasePath, {readOnly: true});
  const counts = {};
  let conversationKeys;
  try {
    for (const table of TABLES) counts[table] = Number(reader.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
    conversationKeys = Number(reader.prepare(`SELECT count(*) AS n FROM kv WHERE key NOT IN ('schema_version','active_model_profile','memory_reset_at')
      AND key NOT GLOB 'model_catalog:*' AND key NOT GLOB 'proactive:v1:*'`).get().n);
  } finally { reader.close(); }
  const summary = {counts, conversationKeys, directories: {
    logs: directories.filter(item => item.category === 'logs').length,
    reports: directories.filter(item => item.category === 'reports').length,
    memoryBackups: directories.filter(item => item.category === 'memoryBackups').length,
    documentArtifacts: documents.length,
    legacyArchives: archives.length,
  }, memoryBackupCreated: false};
  return {root, cfg, databasePath, directories: allDirectories, archives, summary};
}

/** Explicit execution only. A partial failure throws and must not be called a completed reset. */
export async function executeMemoryReset(plan) {
  stoppedService(plan.root);
  // Repeat path checks immediately before committing to the reset, in case a
  // path was swapped between inspection and execution.
  await checkedPath(plan.databasePath, plan.root, 'file');
  for (const item of plan.directories) await checkedPath(item.target, item.parent, 'directory');
  for (const item of plan.archives) await checkedPath(item.target, item.parent, 'file');
  const db = new Database(plan.databasePath);
  let deleted;
  try { deleted = db.clearConversationMemory(); }
  finally { db.close(); }
  const removed = {};
  for (const item of plan.directories) {
    await fs.rm(item.target, {recursive: true, force: true});
    removed[item.category] = (removed[item.category] ?? 0) + 1;
  }
  for (const item of plan.archives) {
    await fs.rm(item.target);
    removed[item.category] = (removed[item.category] ?? 0) + 1;
  }
  const verification = await prepareMemoryReset(plan.root, plan.cfg);
  if (Object.values(verification.summary.counts).some(n => n !== 0) || verification.summary.conversationKeys !== 0
    || Object.values(verification.summary.directories).some(n => n !== 0)) throw new Error('Memory deletion verification failed');
  return {deleted, remaining: verification.summary.counts, conversationKeysRemaining: 0, removed, memoryBackupCreated: false};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const dryRun = args.includes('--dry-run');
  if (execute === dryRun) throw new Error('Specify exactly one of --dry-run or --execute');
  const index = args.indexOf('--config');
  const configName = index < 0 ? 'config.yaml' : args[index + 1];
  if (!configName || args.some((arg, i) => !['--execute','--dry-run','--config'].includes(arg) && !(index >= 0 && i === index + 1))) throw new Error('Unexpected memory reset arguments');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = path.resolve(root, configName);
  within(root, configPath);
  const cfg = loadConfig(configPath);
  const plan = await prepareMemoryReset(root, cfg);
  const result = execute ? await executeMemoryReset(plan) : {dryRun: true, ...plan.summary};
  // Counts only: no chat text, filenames, credentials or new memory copies.
  console.log(JSON.stringify(result));
}
