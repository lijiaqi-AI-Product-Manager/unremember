import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function userHome(): string {
  return resolve(process.env.UNREMEMBER_USER_HOME || homedir())
}

/** Where unremember keeps plans, backups and its journal. */
export function dataHome(): string {
  return resolve(process.env.UNREMEMBER_HOME || join(userHome(), '.unremember'))
}

export function claudeConfigDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(userHome(), '.claude'))
}

export function dshHome(): string {
  return resolve(process.env.DSH_HOME || join(userHome(), '.dsh'))
}

/** Claude Code's project folder name: every non-alphanumeric character becomes '-'. */
export function claudeProjectDirName(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')
}
