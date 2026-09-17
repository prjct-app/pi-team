import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { WorkerClient, workerOptionsFromEnvironment, type WorkerClientOptions } from './worker-client.ts';

export type WorkerLifecycleContext = Pick<ExtensionContext, 'abort' | 'shutdown'>;

export class WorkerBootstrap {
  private context?: WorkerLifecycleContext;
  private readonly client: WorkerClient;

  constructor(
    options: WorkerClientOptions,
    createClient: (options: WorkerClientOptions) => WorkerClient = value => new WorkerClient(value),
  ) {
    this.client = createClient({
      ...options,
      hooks: {
        abort: () => this.context?.abort(),
        shutdown: () => this.context?.shutdown(),
      },
    });
  }

  attach(context: WorkerLifecycleContext): void { this.context = context; }

  start(): Promise<void> {
    if (!this.context) throw new Error('Worker lifecycle context must be attached before control starts.');
    return this.client.start();
  }

  busy(requestId: string): void { this.client.busy(requestId); }

  ready(): void { this.client.ready(); }

  dispose(): void { this.client.stop(); }
}

export function createWorkerBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  createClient?: (options: WorkerClientOptions) => WorkerClient,
): WorkerBootstrap | undefined {
  const options = workerOptionsFromEnvironment({ abort: () => {}, shutdown: () => {} }, environment);
  return options ? new WorkerBootstrap(options, createClient) : undefined;
}
