import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { completer, type CommandOption } from '@prjct.app/pi-tui-kit';
import { TEAM_ID_PATTERN } from '../domain/team.ts';

export const TEAM_HELP = '/team join <team> <role> | send <role> <message> | leave | status | help';
export type TeamCommand =
  | { readonly action: 'status' }
  | { readonly action: 'leave' }
  | { readonly action: 'help' }
  | { readonly action: 'join'; readonly team: string; readonly role: string }
  | { readonly action: 'send'; readonly to: string; readonly body: string };

const name = (value: string | undefined, label: string): string => {
  if (!value || !TEAM_ID_PATTERN.test(value)) throw new Error(`${label} must be 1–48 lowercase letters, digits or hyphens, starting with a letter. ${TEAM_HELP}`);
  return value;
};

export function parseTeamCommand(input: string): TeamCommand {
  const text = input.trim();
  if (!text) return { action: 'status' };
  const [first, ...args] = text.split(/\s+/);
  const action = first!.toLowerCase();
  if (action === 'status' || action === 'leave' || action === 'help') {
    if (args.length) throw new Error(TEAM_HELP);
    return { action };
  }
  if (action === 'join') {
    if (args.length !== 2) throw new Error(`Usage: /team join <team> <role>`);
    return { action, team: name(args[0], 'Team'), role: name(args[1], 'Role') };
  }
  if (action === 'send') {
    const to = name(args[0], 'Role');
    const body = text.slice(text.indexOf(to, first!.length) + to.length).trim();
    if (!body) throw new Error('Usage: /team send <role> <message>');
    return { action, to, body };
  }
  throw new Error(`Unknown /team command. ${TEAM_HELP}`);
}

/** Completions; teams and roles come from what is on disk right now. */
export function commandCompletions(known: { readonly teams: () => readonly string[]; readonly roles: () => readonly string[] }): (prefix: string) => AutocompleteItem[] | null {
  const teams = (): CommandOption[] => known.teams().map(team => ({ value: team, description: `join team ${team}` }));
  const roles = (): CommandOption[] => known.roles().map(role => ({ value: role, description: `message ${role}` }));
  return completer([
    { value: 'join', description: 'join a team under a role (creates the team)', options: teams },
    { value: 'send', description: 'message a teammate now; never queued', options: roles },
    { value: 'status', description: 'who is online and what each is doing' },
    { value: 'leave', description: 'leave the team' },
    { value: 'help', description: 'what /team accepts' },
  ]);
}
