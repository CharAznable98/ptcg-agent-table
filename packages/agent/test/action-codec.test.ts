import test from 'node:test';
import assert from 'node:assert/strict';
import { Type, type TSchema } from '@sinclair/typebox';
import { GameCommandSchema } from '../../protocol/src/commands.ts';
import { MoveKnownInputSchema } from '../../protocol/src/known-card.ts';
import type { ToolDefinition, Json } from '../src/types.ts';
import { validationError } from '../src/schema.ts';
import { modelToolDefinition, decodeActionArguments, SUPPORTED_POSITION_TOOLS } from '../src/action-codec.ts';

function commandTool(name: string, encoded = true): ToolDefinition {
  const full = GameCommandSchema.anyOf.find(schema => schema.properties.kind.const === name)!;
  const { kind: _, ...properties } = full.properties;
  return { name, description: '测试操作', inputSchema: { ...full, properties, required: full.required.filter(key => key !== 'kind') } as TSchema, effect: 'command', ...(encoded ? { argumentEncoding: 'ptcg-positions-v1' as const } : {}) };
}
const zone = (zoneId: string) => ({ kind: 'zone', zoneId });
const group = (zoneId: string, index: number, relation: string) => ({ kind: 'group', position: { zoneId, index }, relation });
const all = (container: Json) => ({ container, range: { mode: 'all' } });
const point = (container: Json, start: number) => ({ container, range: { mode: 'range', start, count: 1 } });
const cases: [string, Json, Json][] = [
  ['move', { source: 'A:hand/2', destination: 'A:active/0/attached/1' }, { source: point(zone('A:hand'), 2), destination: { container: group('A:active', 0, 'attached'), index: 1 } }],
  ['move', { source: { at: 'A:active/0/stack', start: 1, count: 2 }, destination: 'A:discard/0' }, { source: { container: group('A:active', 0, 'stack'), range: { mode: 'range', start: 1, count: 2 } }, destination: { container: zone('A:discard'), index: 0 } }],
  ['look', { selection: 'A:deck' }, { selection: all(zone('A:deck')) }],
  ['show', { selection: 'A:active/0/stack' }, { selection: all(group('A:active', 0, 'stack')) }],
  ['shuffle', { selection: { at: 'A:hand', indices: [3, 0, 2] } }, { selection: { container: zone('A:hand'), range: { mode: 'indices', indices: [3, 0, 2] } } }],
  ['random', { mode: 'selection', count: 1, selection: 'A:active/0/attached/1' }, { mode: 'selection', count: 1, selection: point(group('A:active', 0, 'attached'), 1) }],
  ['random', { mode: 'coins', count: 2 }, { mode: 'coins', count: 2 }],
  ['create_group', { destination: 'A:bench/4' }, { destination: { container: zone('A:bench'), index: 4 } }],
  ['remove_group', { position: 'A:active/0' }, { position: { zoneId: 'A:active', index: 0 } }],
  ['initial_placement', { active: 'A:hand/0', bench: ['A:hand/2', 'A:hand/3'] }, { active: { zoneId: 'A:hand', index: 0 }, bench: [{ zoneId: 'A:hand', index: 2 }, { zoneId: 'A:hand', index: 3 }] }],
  ['additional_bench', { bench: [] }, { bench: [] }],
  ['set_state', { target: { card: 'A:active/0/attached/0' }, field: { key: 'marker', name: 'value', value: 0.5 } }, { target: { kind: 'card', position: { zoneId: 'A:active', index: 0, member: { relation: 'attached', index: 0 } } }, field: { key: 'marker', name: 'value', value: 0.5 } }],
  ['set_state', { target: { group: 'A:bench/2' }, field: { key: 'damageCounters', value: 3 } }, { target: { kind: 'group', position: { zoneId: 'A:bench', index: 2 } }, field: { key: 'damageCounters', value: 3 } }],
  ['set_state', { target: { player: 'B' }, field: { key: 'marker', name: 'attached', value: true } }, { target: { kind: 'player', playerId: 'B' }, field: { key: 'marker', name: 'attached', value: true } }],
  ['set_state', { target: { zone: 'stadium' }, field: { key: 'visibility', value: { mode: 'public' } } }, { target: { kind: 'zone', zoneId: 'stadium' }, field: { key: 'visibility', value: { mode: 'public' } } }],
];

test('短位置覆盖实际原命令形态，解码保持命令语义及字段值', () => {
  for (const [name, wire, canonical] of cases) {
    const tool = commandTool(name), original = JSON.stringify(tool.inputSchema);
    assert.equal(validationError(modelToolDefinition(tool).inputSchema, wire), null, name);
    assert.deepEqual(decodeActionArguments(tool, wire), canonical, name);
    assert.equal(validationError(tool.inputSchema, canonical), null, name);
    assert.equal(JSON.stringify(tool.inputSchema), original);
  }
});

test('无编码标记的权限上下文及未知工具接口保持原样', () => {
  const tool = commandTool('move', false), args = cases[0]![2];
  assert.equal(modelToolDefinition(tool), tool);
  assert.equal(decodeActionArguments(tool, args), args);
  assert.ok(!SUPPORTED_POSITION_TOOLS.includes('declare'));
  for (const name of ['declare', 'show_known']) {
    const unknown = { name, description: '自定义', inputSchema: Type.Object({ text: Type.String() }), effect: 'command' as const, argumentEncoding: 'ptcg-positions-v1' as const };
    const args = { text: 'A:hand/2' };
    assert.equal(modelToolDefinition(unknown), unknown);
    assert.equal(decodeActionArguments(unknown, args), args);
  }
});

test('短位置拒绝无效路径、越界整数、结构歧义及多余字段', () => {
  const invalid: [string, Json][] = [
    ...['A:hand/-1','A:hand/01','A:hand/1.2','A:hand/1e2','A:hand/2/stack/extra','A:hand/2/nope/1','A:hand/2/attached/1/extra','A:hand/9007199254740992','A:hand/1/stack/9007199254740992','A:hand//2','../A:hand/2','A:hand/Infinity','A:hand/NaN','A:hand/2\n','A:hand/2\r','A:hand/2\u2028','A:hand/0/stack/-1'].map(source => ['move', { source, destination: 'A:discard/0' }] as [string, Json]),
    ['move', { source: { at: 'A:deck', start: -1, count: 1 }, destination: 'A:hand/0' }],
    ['move', { source: { at: 'A:deck', start: 0, count: 9007199254740992 }, destination: 'A:hand/0' }],
    ['move', { source: { at: 'A:deck', indices: [0, 0] }, destination: 'A:hand/0' }],
    ['move', { source: { at: 'A:deck', indices: [0.5] }, destination: 'A:hand/0' }],
    ['move', { source: { at: 'A:deck', start: 0, count: 1, indices: [0] }, destination: 'A:hand/0' }],
    ['move', { source: { at: 'A:active/0', start: 0, count: 1 }, destination: 'A:hand/0' }],
    ['move', { source: 'A:hand/0', destination: 'A:discard' }],
    ['move', { source: 'A:hand/0', destination: 'A:discard/0', extra: true }],
    ['set_state', { target: { group: 'A:bench/0/stack/0' }, field: { key: 'damageCounters', value: 1 } }],
    ['set_state', { target: { card: 'A:hand/0', player: 'A' }, field: { key: 'damageCounters', value: 1 } }],
    ['set_state', { target: { player: 'C' }, field: { key: 'damageCounters', value: 1 } }],
    ['set_state', { target: { zone: 'A:deck/0' }, field: { key: 'damageCounters', value: 1 } }],
  ];
  for (const [name, wire] of invalid) {
    const tool = commandTool(name);
    assert.notEqual(validationError(modelToolDefinition(tool).inputSchema, wire), null, JSON.stringify(wire));
    assert.throws(() => decodeActionArguments(tool, wire), /ACTION_ARGUMENTS_INVALID/, JSON.stringify(wire));
  }
});

test('最大安全整数可解码，保留原字段约束，move_known只编码目的位置', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const tool = commandTool('look');
  assert.deepEqual(decodeActionArguments(tool, { selection: `A:deck/${max}` }), { selection: point(zone('A:deck'), max) });
  const canonical = { selection: { container: zone('A:deck'), range: { mode: 'range', start: max, count: 1 } } };
  assert.ok(validationError(tool.inputSchema, canonical) === null);
  const known: ToolDefinition = { name: 'move_known', description: '按牌面移动', effect: 'command', argumentEncoding: 'ptcg-positions-v1', inputSchema: Type.Object({ name: Type.String({ minLength: 1 }), destination: Type.Object({ container: Type.Object({ kind: Type.Literal('zone'), zoneId: Type.String() }), index: Type.Integer({ minimum: 0 }) }) }, { additionalProperties: false }) };
  assert.deepEqual(decodeActionArguments(known, { name: '合成卡', destination: 'A:hand/2' }), { name: '合成卡', destination: { container: zone('A:hand'), index: 2 } });
  assert.notEqual(validationError(modelToolDefinition(known).inputSchema, { name: '合成卡', destination: 'A:hand/end' }), null, '旧的数字目的地schema不能被编码层扩大');
  assert.throws(() => decodeActionArguments(known, { name: '合成卡', destination: 'A:hand/end' }), /ACTION_ARGUMENTS_INVALID/);
  const limited = commandTool('initial_placement');
  limited.inputSchema.properties.bench.maxItems = 1;
  assert.notEqual(validationError(modelToolDefinition(limited).inputSchema, { active: 'A:hand/0', bench: ['A:hand/1', 'A:hand/2'] }), null);
});

test('所有十进制位数与最大安全整数边界在schema及解码一致', () => {
  const tool = commandTool('look');
  const wire = modelToolDefinition(tool);
  const values = [0n, 1n, 9n, 10n, 99n, 1_000_000n, 8_999_999_999_999_999n, 9_000_000_000_000_000n, 9_007_199_254_740_990n, 9_007_199_254_740_991n, 9_007_199_254_740_992n, 9_999_999_999_999_999n, 10_000_000_000_000_000n];
  for (const value of values) {
    const args = { selection: `A:deck/${value}` }, safe = value <= BigInt(Number.MAX_SAFE_INTEGER);
    assert.equal(validationError(wire.inputSchema, args) === null, safe, String(value));
    if (safe) assert.deepEqual(decodeActionArguments(tool, args), { selection: point(zone('A:deck'), Number(value)) });
    else assert.throws(() => decodeActionArguments(tool, args), /ACTION_ARGUMENTS_INVALID/);
  }
});

test('move和move_known支持目的容器/end，源位置和create_group仍只接受数字', () => {
  const tool = commandTool('move');
  for (const [destination, container] of [['A:deck/end', zone('A:deck')], ['A:active/0/attached/end', group('A:active', 0, 'attached')], ['A:active/0/stack/end', group('A:active', 0, 'stack')]] as [string, Json][]) {
    const args = { source: 'A:hand/2', destination };
    assert.equal(validationError(modelToolDefinition(tool).inputSchema, args), null, destination);
    assert.deepEqual(decodeActionArguments(tool, args), { source: point(zone('A:hand'), 2), destination: { container, index: 'end' } });
  }
  const known: ToolDefinition = { name: 'move_known', description: '移动已选牌面', effect: 'command', argumentEncoding: 'ptcg-positions-v1', inputSchema: MoveKnownInputSchema };
  const knownArgs = { zoneId: 'A:hand', name: '合成卡', destination: 'A:deck/end' };
  assert.equal(validationError(modelToolDefinition(known).inputSchema, knownArgs), null);
  assert.deepEqual(decodeActionArguments(known, knownArgs), { zoneId: 'A:hand', name: '合成卡', destination: { container: zone('A:deck'), index: 'end' } });
  for (const [name, args] of [
    ['move', { source: 'A:hand/end', destination: 'A:deck/0' }],
    ['move', { source: 'A:hand/0', destination: 'A:active/end/attached/0' }],
    ['move', { source: 'A:hand/0', destination: 'A:active/0/end' }],
    ['move', { source: 'A:hand/0', destination: 'A:active/0/attached/end\n' }],
    ['move', { source: 'A:hand/0', destination: 'A:active/9007199254740992/attached/end' }],
    ['create_group', { destination: 'A:bench/end' }],
    ['look', { selection: 'A:deck/end' }],
    ['set_state', { target: { card: 'A:deck/end' }, field: { key: 'visibility', value: null } }],
  ] as [string, Json][]) {
    const definition = commandTool(name);
    assert.notEqual(validationError(modelToolDefinition(definition).inputSchema, args), null, JSON.stringify(args));
    assert.throws(() => decodeActionArguments(definition, args), /ACTION_ARGUMENTS_INVALID/);
  }
});
