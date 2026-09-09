import { Type } from 'typebox';
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const name = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' });
const id = Type.String({ minLength: 1, maxLength: 128 });
export const ResultSchema = Type.Object({
  outcome: enumOf('completed', 'failed', 'interrupted'),
  body: Type.String({ maxLength: 16000 }),
  files: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 50 }),
  tests: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 50 }),
});
export const StateSchema = Type.Object({
  version: Type.Literal(1),
  members: Type.Array(Type.Object({
    team: name, alias: name, session: id, token: id,
    cwd: Type.String({ maxLength: 4096 }), pid: Type.Integer({ minimum: 1 }),
    seen: Type.Number({ minimum: 0 }), status: enumOf('idle', 'busy', 'paused', 'offline'),
  }), { maxItems: 100 }),
  messages: Type.Array(Type.Object({
    id, team: name, from: name, to: name,
    subject: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ maxLength: 16000 }),
    kind: enumOf('request', 'note', 'result'), state: enumOf('pending', 'processing', 'completed', 'interrupted', 'seen'),
    created: Type.Number({ minimum: 0 }), rootId: id, parentId: Type.Optional(id), claim: Type.Optional(id),
    result: Type.Optional(ResultSchema),
  }), { maxItems: 500 }),
});
