import test from 'node:test';
import assert from 'node:assert/strict';
import { GameCommandSchema } from '../../protocol/src/index.ts';
import { validationError } from '../../agent/src/schema.ts';

test('共享schema在执行前阻止check携带玩家，以及turn缺少玩家', () => {
  for (const command of [{ kind: 'set_turn', phase: 'check', playerId: 'A' }, { kind: 'set_turn', phase: 'check', playerId: 'B' }, { kind: 'set_turn', phase: 'turn', playerId: null }]) {
    assert.ok(validationError(GameCommandSchema, command), JSON.stringify(command));
  }
  for (const command of [{ kind: 'set_turn', phase: 'check', playerId: null }, { kind: 'set_turn', phase: 'turn', playerId: 'A' }, { kind: 'set_turn', phase: 'turn', playerId: 'B' }]) {
    assert.equal(validationError(GameCommandSchema, command), null);
  }
});
