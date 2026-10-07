import type { ToolRenderers } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { row, SYMBOL } from '@prjct.app/pi-tui-kit';

/** Available before joining, so restored messages never fall back to raw JSON. */
export const teamMessageRenderers: ToolRenderers = {
  renderShell: 'self',
  renderCall: (args: any, theme, context) => context?.isPartial === false ? new Container()
    : row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'TEAM', target: `→ ${args?.to ?? 'teammate'}`, meta: 'sending…' }),
  renderResult: (result: any, state, theme, context) => {
    const failed = Boolean(context?.isError);
    const args = result?.details?.status === 'submitted' ? result.details : context?.args ?? {};
    const component = new Container();
    component.addChild(row(theme, { symbol: failed ? SYMBOL.error : SYMBOL.ok, tone: failed ? 'error' : 'success', verb: 'TEAM',
      target: `→ ${args.to ?? 'teammate'}`, meta: failed ? 'failed' : `${args.kind ?? 'message'} · sent`,
      ...(failed ? { metaTone: 'error' as const } : {}) }));
    if (failed || state.expanded) component.addChild(new Text(String(failed ? result?.content?.[0]?.text ?? 'Send failed.' : args.body ?? ''), 2, 0));
    return component;
  },
};
