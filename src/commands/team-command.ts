export const TEAM_COMMANDS = [
  'create', 'join', 'start', 'status', 'inbox', 'receive', 'stop', 'kill', 'leave', 'close',
  'doctor', 'purge',
] as const;

export type TeamCommand =
  | { readonly action: 'create'; readonly teamId: string; readonly alias: string }
  | { readonly action: 'join'; readonly teamId: string; readonly alias: string }
  | { readonly action: 'start'; readonly alias: string; readonly cwd: string }
  | { readonly action: 'status' | 'inbox' | 'leave' | 'close' | 'doctor' }
  | { readonly action: 'receive'; readonly messageId: string }
  | { readonly action: 'stop' | 'kill'; readonly alias: string }
  | { readonly action: 'purge'; readonly teamId: string };

export const TEAM_HELP = 'Usage: /team create <team> <alias> | join <team> <alias> | start <alias> <existing-cwd> | status | inbox | receive <message-id> | stop <alias> | kill <alias> | leave | close | doctor | purge <closed-team>';

function words(input: string): readonly string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function parseTeamCommand(input: string): TeamCommand {
  const [action, first, second, ...extra] = words(input);
  if (!action) return { action: 'status' };
  if ((action === 'create' || action === 'join') && first && second && extra.length === 0) {
    return { action, teamId: first, alias: second };
  }
  if (action === 'start' && first && second && extra.length === 0) {
    return { action, alias: first, cwd: second };
  }
  if (['status', 'inbox', 'leave', 'close', 'doctor'].includes(action) && !first) {
    return { action: action as 'status' | 'inbox' | 'leave' | 'close' | 'doctor' };
  }
  if (action === 'receive' && first && !second) return { action, messageId: first };
  if ((action === 'stop' || action === 'kill') && first && !second) return { action, alias: first };
  if (action === 'purge' && first && !second) return { action, teamId: first };
  throw new Error(TEAM_HELP);
}

export function commandCompletions(prefix: string): { value: string; label: string }[] {
  const input = prefix.trimStart();
  if (input.includes(' ')) return [];
  return TEAM_COMMANDS.filter(value => value.startsWith(input)).map(value => ({ value, label: value }));
}
