import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { bounded } from '../dynamic/domain.ts';
import { completer } from '@prjct.app/pi-tui-kit';

export const TEAM_HELP = '/team <objective> | status | history | doctor | cancel [run-id] | help';
export type TeamCommand =
  | { readonly action: 'objective'; readonly objective: string }
  | { readonly action: 'status' | 'history' | 'doctor' | 'help' }
  | { readonly action: 'cancel'; readonly runId?: string };
const removed = new Set(['create', 'join', 'migrate', 'legacy', 'start', 'stop', 'kill', 'leave', 'close', 'purge', 'receive', 'inbox']);
export function parseTeamCommand(input: string): TeamCommand {
  const text = input.trim();
  bounded(text, 8192, 'Objective');
  if (!text) return { action: 'status' };
  const [first, ...args] = text.split(/\s+/);
  const action = first!.toLowerCase();
  // Old lifecycle commands were short ("create shop lead"). A sentence that
  // merely starts with one of those words ("Create three files…") is an objective.
  if (removed.has(action) && args.length <= 2) throw new Error(`Unsupported Team command. ${TEAM_HELP}`);
  if (['status', 'history', 'doctor', 'help'].includes(action)) {
    if (args.length) throw new Error(TEAM_HELP);
    return { action: action as 'status' | 'history' | 'doctor' | 'help' };
  }
  if (action === 'cancel') {
    if (args.length > 1 || (args[0] && !/^[a-zA-Z0-9-]{1,128}$/.test(args[0]))) throw new Error(TEAM_HELP);
    return { action, ...(args[0] ? { runId: args[0] } : {}) };
  }
  return { action: 'objective', objective: text };
}
/** Subcommands with the prjct mark. Anything else typed after /team is a new objective. */
export const commandCompletions: (prefix: string) => AutocompleteItem[] | null = completer([
  { value: 'status', description: 'panel of Runs and Experts' },
  { value: 'history', description: 'the last Runs as text' },
  { value: 'doctor', description: 'ownership and blocked experts' },
  { value: 'cancel', description: 'cancel the active Run (owner only)' },
  { value: 'help', description: 'what /team accepts' },
]);
