
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import lockfile from 'proper-lockfile';

const CONTEXT_DIR = path.join(os.homedir(), '.context');
const LOCK_FILE = path.join(CONTEXT_DIR, 'leader.lock');
const LOCKS_DIR = path.join(CONTEXT_DIR, 'locks');

// Ensure the .context directory exists
if (!fs.existsSync(CONTEXT_DIR)) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
}

// Ensure the locks directory exists
if (!fs.existsSync(LOCKS_DIR)) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
}

let isLeader = false;
let lockInterval: NodeJS.Timeout | undefined;

// Track codebase locks held by this process
const heldCodebaseLocks = new Map<string, string>(); // Map<codebasePath, lockFilePath>

export async function acquireLock(): Promise<boolean> {
    if (isLeader) {
        return true;
    }
    try {
        // Using flock is generally more reliable as the lock is released by the OS if the process dies.
        // proper-lockfile will use flock on systems that support it (Linux, BSD, etc.)
        // and fall back to other mechanisms on systems that don't (like Windows).
        await lockfile.lock(LOCK_FILE, { retries: 0, realpath: false });
        isLeader = true;
        console.log('Acquired leader lock. This process is now the leader.');
        if (lockInterval) {
            clearInterval(lockInterval);
            lockInterval = undefined;
        }
        return true;
    } catch (error) {
        console.log('Could not acquire leader lock, running as follower.');
        isLeader = false;
        if (!lockInterval) {
            lockInterval = setInterval(acquireLock, 5000); // Check every 5 seconds
        }
        return false;
    }
}

export async function releaseLock(): Promise<void> {
  if (isLeader) {
    try {
      await lockfile.unlock(LOCK_FILE, { realpath: false });
      isLeader = false;
      console.log('Released leader lock.');
    } catch (error) {
      console.error('Error releasing leader lock:', error);
    }
  }
}

export function isCurrentProcessLeader(): boolean {
  return isLeader;
}

export function getLockFilePath(): string {
  return LOCK_FILE;
}

/**
 * Get the codebase lock file path for a given codebase path
 */
function getCodebaseLockPath(codebasePath: string): string {
  const normalizedPath = path.resolve(codebasePath);
  const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
  return path.join(LOCKS_DIR, hash);
}

/**
 * Acquire a codebase lock for indexing a specific codebase
 * Returns true if lock acquired, false if already locked by another process
 */
export async function acquireCodebaseLock(codebasePath: string): Promise<boolean> {
  // Check if we already hold this lock
  if (heldCodebaseLocks.has(codebasePath)) {
    return true;
  }

  const lockPath = getCodebaseLockPath(codebasePath);

  try {
    await lockfile.lock(lockPath, { retries: 0, realpath: false });
    heldCodebaseLocks.set(codebasePath, lockPath);
    console.log(`[LOCK] Acquired codebase lock for: ${codebasePath}`);
    return true;
  } catch (error) {
    console.log(`[LOCK] Codebase lock already held by another process: ${codebasePath}`);
    return false;
  }
}

/**
 * Release a codebase lock for a specific codebase
 */
export async function releaseCodebaseLock(codebasePath: string): Promise<void> {
  const lockPath = heldCodebaseLocks.get(codebasePath);

  if (!lockPath) {
    return; // We don't hold this lock
  }

  try {
    await lockfile.unlock(lockPath, { realpath: false });
    heldCodebaseLocks.delete(codebasePath);
    console.log(`[LOCK] Released codebase lock for: ${codebasePath}`);
  } catch (error) {
    console.error(`[LOCK] Error releasing codebase lock for ${codebasePath}:`, error);
  }
}

/**
 * Release all codebase locks held by this process
 */
async function releaseAllCodebaseLocks(): Promise<void> {
  const lockPaths = Array.from(heldCodebaseLocks.keys());
  for (const codebasePath of lockPaths) {
    await releaseCodebaseLock(codebasePath);
  }
}

/**
 * Check if a codebase is currently locked (by any process)
 */
export function isCodebaseLocked(codebasePath: string): boolean {
  const lockPath = getCodebaseLockPath(codebasePath);
  const lockFilePath = `${lockPath}.lock`; // proper-lockfile adds .lock suffix

  // First check if lock file exists - if not, definitely not locked
  if (!fs.existsSync(lockFilePath)) {
    return false;
  }

  try {
    // Lock file exists, now check if it's actually held by a process
    lockfile.checkSync(lockPath, { realpath: false });
    return true;
  } catch (error) {
    // Lock file exists but is stale/not held
    return false;
  }
}

// Graceful shutdown
process.on('exit', async () => {
  await releaseAllCodebaseLocks();
  await releaseLock();
});

process.on('SIGINT', async () => {
  await releaseAllCodebaseLocks();
  await releaseLock();
  process.exit();
});

process.on('SIGTERM', async () => {
  await releaseAllCodebaseLocks();
  await releaseLock();
  process.exit();
});
