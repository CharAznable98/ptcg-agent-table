import { Type, type TSchema } from '@sinclair/typebox';
import type { Container, Destination, MoveDestination, Position, Selection } from '../../protocol/src/commands.ts';
import { validationError } from './schema.ts';
import type { ToolDefinition, Json } from './types.ts';

/** 仅改变显式选择该编码的模型参数；公共协议及宿主权限保持原样。 */
export const SUPPORTED_POSITION_TOOLS: readonly string[] = Object.freeze([
  'move', 'look', 'show', 'shuffle', 'random', 'create_group', 'remove_group',
  'initial_placement', 'additional_bench', 'set_state', 'move_known',
]);
const supported = new Set(SUPPORTED_POSITION_TOOLS);
const encoding = 'ptcg-positions-v1';
const maxInteger = Number.MAX_SAFE_INTEGER;
const obj = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const zonePart = '[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)?';

/** 字符串坐标也必须在 schema 层排除不安全整数，不能只限制解码后的 number。 */
function safeDecimalPattern(): string {
  const maximum = String(maxInteger), alternatives = ['0', '[1-9][0-9]{0,14}'];
  for (let index = 0; index < maximum.length; index++) {
    const lower = index === 0 ? 1 : 0, upper = Number(maximum[index]) - 1;
    if (upper < lower) continue;
    const digit = lower === upper ? String(lower) : `[${lower}-${upper}]`;
    const remaining = maximum.length - index - 1;
    alternatives.push(maximum.slice(0, index) + digit + (remaining ? `[0-9]{${remaining}}` : ''));
  }
  return `(?:${[...alternatives, maximum].join('|')})`;
}
const zonePattern = new RegExp(`^${zonePart}(?![\\s\\S])`);
const indexPart = safeDecimalPattern();
const coordinate = (pattern: string) => Type.String({ pattern: `^${pattern}(?![\\s\\S])`, minLength: 1, maxLength: 256 });
const ZoneWire = Type.String({ pattern: `^${zonePart}(?![\\s\\S])`, minLength: 1, maxLength: 256 });
const RootPositionWire = coordinate(`${zonePart}/${indexPart}`);
const PositionWire = coordinate(`${zonePart}/${indexPart}(?:/(?:stack|attached)/${indexPart})?`);
const MoveDestinationWire = coordinate(`${zonePart}/(?:${indexPart}(?:/(?:stack|attached)/(?:${indexPart}|end))?|end)`);
const ContainerWire = coordinate(`${zonePart}(?:/${indexPart}/(?:stack|attached))?`);
const SelectionStringWire = coordinate(`${zonePart}(?:/${indexPart}(?:/(?:stack|attached)(?:/${indexPart})?)?)?`);
const IndexWire = Type.Integer({ minimum: 0, maximum: maxInteger });
const SelectionWire = Type.Union([
  SelectionStringWire,
  obj({ at: ContainerWire, start: IndexWire, count: IndexWire }),
  obj({ at: ContainerWire, indices: Type.Array(IndexWire, { uniqueItems: true }) }),
]);
const TargetWire = Type.Union([
  obj({ card: PositionWire }), obj({ group: RootPositionWire }),
  obj({ player: Type.Union([Type.Literal('A'), Type.Literal('B')]) }), obj({ zone: ZoneWire }),
]);
const definitions = new WeakMap<ToolDefinition, ToolDefinition>();
function encoded(tool: ToolDefinition): boolean {
  return tool.argumentEncoding === encoding && supported.has(tool.name)
    && tool.inputSchema.type === 'object' && !!tool.inputSchema.properties;
}

/** 调用方始终保留原 catalog，用其再次验证解码后的原命令参数。 */
export function modelToolDefinition(tool: ToolDefinition): ToolDefinition {
  if (!encoded(tool)) return tool;
  const cached = definitions.get(tool);
  if (cached) return cached;
  const properties = { ...tool.inputSchema.properties } as Record<string, TSchema>;
  const destinationIndex = properties.destination?.properties?.index as TSchema | undefined;
  const destinationWire = destinationIndex && validationError(destinationIndex, 'end') === null ? MoveDestinationWire : PositionWire;
  const replace = (name: string, schema: TSchema) => { if (properties[name]) properties[name] = schema; };
  const positions = (name: string) => {
    if (properties[name]?.type === 'array') properties[name] = { ...properties[name], items: PositionWire };
  };
  switch (tool.name) {
    case 'move': replace('source', SelectionWire); replace('destination', destinationWire); break;
    case 'move_known': replace('destination', destinationWire); break;
    case 'create_group': replace('destination', PositionWire); break;
    case 'look': case 'show': case 'shuffle': case 'random': replace('selection', SelectionWire); break;
    case 'remove_group': replace('position', PositionWire); break;
    case 'initial_placement': replace('active', PositionWire); positions('bench'); break;
    case 'additional_bench': positions('bench'); break;
    case 'set_state': replace('target', TargetWire); break;
  }
  const result: ToolDefinition = { ...tool, inputSchema: { ...tool.inputSchema, properties } as TSchema };
  definitions.set(tool, result);
  return result;
}
const invalid = (): never => { throw new Error('ACTION_ARGUMENTS_INVALID'); };
const record = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
function safeIndex(value: unknown): number {
  const number = typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?![\s\S])/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return invalid();
  return number;
}
type Path = { kind: 'zone'; zoneId: string } | { kind: 'position'; position: Position } | { kind: 'container'; container: Container };
function path(value: Json | undefined): Path {
  if (typeof value !== 'string' || value.length > 256) return invalid();
  const parts = value.split('/'), zoneId = parts[0]!;
  if (!zonePattern.test(zoneId)) return invalid();
  if (parts.length === 1) return { kind: 'zone', zoneId };
  const index = safeIndex(parts[1]);
  if (parts.length === 2) return { kind: 'position', position: { zoneId, index } };
  const relation = parts[2];
  if (relation !== 'stack' && relation !== 'attached') return invalid();
  if (parts.length === 3) return { kind: 'container', container: { kind: 'group', position: { zoneId, index }, relation } };
  if (parts.length === 4) return { kind: 'position', position: { zoneId, index, member: { relation, index: safeIndex(parts[3]) } } };
  return invalid();
}
function position(value: Json | undefined): Position { const parsed = path(value); return parsed.kind === 'position' ? parsed.position : invalid(); }
function container(value: Json | undefined): Container {
  const parsed = path(value);
  return parsed.kind === 'zone' ? { kind: 'zone', zoneId: parsed.zoneId } : parsed.kind === 'container' ? parsed.container : invalid();
}
function destination(value: Json | undefined): Destination {
  const { zoneId, index, member } = position(value);
  return member ? { container: { kind: 'group', position: { zoneId, index }, relation: member.relation }, index: member.index }
    : { container: { kind: 'zone', zoneId }, index };
}
function moveDestination(value: Json | undefined): MoveDestination {
  if (typeof value === 'string' && value.endsWith('/end')) return { container: container(value.slice(0, -4)), index: 'end' };
  return destination(value);
}
function selection(value: Json | undefined): Selection {
  if (typeof value === 'string') {
    const parsed = path(value);
    if (parsed.kind === 'position') {
      const { zoneId, index, member } = parsed.position;
      return member ? { container: { kind: 'group', position: { zoneId, index }, relation: member.relation }, range: { mode: 'range', start: member.index, count: 1 } }
        : { container: { kind: 'zone', zoneId }, range: { mode: 'range', start: index, count: 1 } };
    }
    return { container: container(value), range: { mode: 'all' } };
  }
  const object = record(value);
  const target = container(object.at);
  if (Array.isArray(object.indices)) return { container: target, range: { mode: 'indices', indices: object.indices.map(safeIndex) } };
  return { container: target, range: { mode: 'range', start: safeIndex(object.start), count: safeIndex(object.count) } };
}
function target(value: Json | undefined): Json {
  const object = record(value);
  if (Object.hasOwn(object, 'card')) return { kind: 'card', position: position(object.card) };
  if (Object.hasOwn(object, 'group')) {
    const root = position(object.group);
    if (root.member) return invalid();
    return { kind: 'group', position: root };
  }
  if (Object.hasOwn(object, 'player')) return { kind: 'player', playerId: object.player! };
  if (Object.hasOwn(object, 'zone')) return { kind: 'zone', zoneId: object.zone! };
  return invalid();
}

/** 无副作用的边界解码：原工具、权限和所有剩余字段约束仍由宿主持有。 */
export function decodeActionArguments(tool: ToolDefinition, args: Json): Json {
  if (!encoded(tool)) return args;
  if (validationError(modelToolDefinition(tool).inputSchema, args)) return invalid();
  const original = record(args), result = { ...original };
  switch (tool.name) {
    case 'move': result.source = selection(original.source) as Json; result.destination = moveDestination(original.destination) as Json; break;
    case 'move_known': result.destination = moveDestination(original.destination) as Json; break;
    case 'create_group': result.destination = destination(original.destination) as Json; break;
    case 'look': case 'show': case 'shuffle': result.selection = selection(original.selection) as Json; break;
    case 'random': if (Object.hasOwn(original, 'selection')) result.selection = selection(original.selection) as Json; break;
    case 'remove_group': result.position = position(original.position) as Json; break;
    case 'initial_placement': result.active = position(original.active) as Json; result.bench = (original.bench as Json[]).map(position) as Json; break;
    case 'additional_bench': result.bench = (original.bench as Json[]).map(position) as Json; break;
    case 'set_state': result.target = target(original.target); break;
  }
  if (validationError(tool.inputSchema, result)) return invalid();
  return result;
}
