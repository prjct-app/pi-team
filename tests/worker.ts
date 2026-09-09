// A separate OS process hosting the public Pi adapter with a simulated model.
import { harness } from './harness.ts';
const agent = harness(process.argv[2], process.argv[3], JSON.parse(process.argv[4] ?? '[]'));
await agent.emit('session_start', { reason: 'startup' });
process.on('message', async (message: { id: number; op: string; value?: any }) => {
  try {
    let value: unknown;
    switch (message.op) {
      case 'command': await agent.command(message.value); break;
      case 'send': value = await agent.send(message.value); break;
      case 'busy': agent.busy(message.value); break;
      case 'finish':
        await agent.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: message.value }] } });
        agent.busy(false); await agent.emit('agent_settled'); break;
      case 'snapshot': value = { received: agent.received, notices: agent.notices, entries: agent.entries }; break;
      case 'stop': await agent.emit('session_shutdown'); break;
      default: throw new Error('Unknown test operation');
    }
    process.send?.({ id: message.id, value });
    if (message.op === 'stop') process.disconnect();
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.send?.({ ready: true });
