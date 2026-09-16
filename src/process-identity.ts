import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export type ProcessIdentity = Readonly<{
  processPid: number;
  processStartToken: string;
  processGroupId: number;
}>;

export type ProcessController = Readonly<{
  inspect(processPid: number): Promise<ProcessIdentity | undefined>;
  signal(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<boolean>;
  delay(ms: number): Promise<void>;
}>;

function ps(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('ps', [...args], { env: process.env, timeout: 2_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolvePromise(String(stdout).trim());
    });
  });
}

async function inspectLinuxProcess(processPid: number): Promise<ProcessIdentity | undefined> {
  const stat = await readFile(`/proc/${processPid}/stat`, 'utf8').catch(() => '');
  const commandEnd = stat.lastIndexOf(') ');
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/) : [];
  const processGroupId = Number(fields[2]);
  const startedAtClockTick = fields[19] ?? '';
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1 || !/^\d+$/.test(startedAtClockTick)) return undefined;
  return { processPid, processGroupId, processStartToken: `linux:${startedAtClockTick}` };
}

async function inspectPortableProcess(processPid: number): Promise<ProcessIdentity | undefined> {
  const output = await ps(['-o', 'pgid=', '-o', 'lstart=', '-p', String(processPid)]).catch(() => '');
  const match = output.match(/^(\d+)\s+(.+)$/);
  if (!match) return undefined;
  const processGroupId = Number(match[1]);
  const processStartToken = match[2]?.trim() ?? '';
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1 || !processStartToken) return undefined;
  return { processPid, processStartToken: `ps:${processStartToken}`, processGroupId };
}

export async function inspectProcess(processPid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(processPid) || processPid <= 1) return undefined;
  return process.platform === 'linux' ? inspectLinuxProcess(processPid) : inspectPortableProcess(processPid);
}

export function sameProcess(left: ProcessIdentity, right: ProcessIdentity | undefined): boolean {
  return !!right && left.processPid === right.processPid && left.processStartToken === right.processStartToken &&
    left.processGroupId === right.processGroupId;
}

async function signal(identity: ProcessIdentity, value: NodeJS.Signals): Promise<boolean> {
  if (!sameProcess(identity, await inspectProcess(identity.processPid))) return false;
  try { process.kill(-identity.processGroupId, value); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export const defaultProcessController: ProcessController = {
  inspect: inspectProcess,
  signal,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
