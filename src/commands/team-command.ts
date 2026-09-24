import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { completer, type CommandOption } from '@prjct.app/pi-tui-kit';
import { TEAM_ID_PATTERN } from '../domain/team.ts';

export const TEAM_HELP = '/team join <team> <role> | send <role> <message> | rename <team-name> | rename-role <role> <new-role> | leave | remove <role> | delete | status | help';
export type TeamCommand =
  | { readonly action: 'status' }
  | { readonly action: 'leave' }
  | { readonly action: 'help' }
  | { readonly action: 'delete' }
  | { readonly action: 'remove'; readonly role: string }
  | { readonly action: 'rename'; readonly name: string }
  | { readonly action: 'rename-role'; readonly role: string; readonly name: string }
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
  if (action === 'rename') {
    if (args.length !== 1) throw new Error('Usage: /team rename <new-team-name>');
    return { action, name: name(args[0], 'Team') };
  }
  if (action === 'rename-role') {
    if (args.length !== 2) throw new Error('Usage: /team rename-role <role> <new-role>');
    return { action, role: name(args[0], 'Role'), name: name(args[1], 'Role') };
  }
  if (action === 'remove') {
    if (args.length !== 1) throw new Error('Usage: /team remove <role>');
    return { action, role: name(args[0], 'Role') };
  }
  if (action === 'status' || action === 'leave' || action === 'help' || action === 'delete') {
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
    { value: 'leave', description: 'leave the team (asks first)' },
    { value: 'remove', description: 'admin: take a member out of the team (asks first)', options: roles },
    { value: 'delete', description: 'admin: delete the team you created (asks first)' },
    { value: 'rename', description: 'admin: rename the team (asks first)' },
    { value: 'rename-role', description: 'rename your role, or any role as admin (asks first)', options: roles },
    { value: 'help', description: 'what /team accepts' },
  ]);
}
