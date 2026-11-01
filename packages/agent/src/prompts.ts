import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { parseStructured } from './schema.ts';

/** 所有会影响决策的静态自然语言统一配置；版本由实际内容计算，不信任提交的 version。 */
const text = Type.String({ minLength: 1, maxLength: 200_000 });
const requiredToolNames = ['move', 'shuffle', 'set_state', 'look', 'show', 'random', 'create_group', 'remove_group', 'declare', 'set_turn', 'handoff', 'report_result', 'confirm_result', 'concede', 'choose_first', 'initial_placement', 'mulligan_draw', 'additional_bench', 'object', 'respond', 'read_history', 'read_rules', 'submit_result'];
const requiredFeedbackNames = ['playerToolCountInvalid', 'playerToolRequired', 'invalidArgumentsJson', 'toolUnavailable', 'structuredToolRequired', 'playerRulesHeading', 'judgeRulesHeading', 'modelTestInstructions', 'modelTestUser'];
export const PromptConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1), player: text, judge: text, summary: text, compactor: text, humanExecutor: Type.Optional(text),
  toolDescriptions: Type.Record(Type.String(), text), feedback: Type.Record(Type.String(), text),
  version: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type PromptConfiguration = Static<typeof PromptConfigSchema>;
export type PromptBundle = Omit<PromptConfiguration, 'version'> & { version: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function parsePrompts(input: unknown): PromptBundle {
  const parsed = parseStructured<PromptConfiguration>(PromptConfigSchema, input);
  for (const name of requiredToolNames) if (!Object.hasOwn(parsed.toolDescriptions, name)) throw new Error(`PROMPT_TOOL_DESCRIPTION_MISSING: ${name}`);
  for (const name of requiredFeedbackNames) if (!Object.hasOwn(parsed.feedback, name)) throw new Error(`PROMPT_FEEDBACK_MISSING: ${name}`);
  const { version: _submittedVersion, ...contents } = parsed;
  return { ...structuredClone(contents), version: createHash('sha256').update(canonical(contents)).digest('hex') };
}

/** 调用方在建局时加载并保存本局快照，运行中不自动读取可变配置文件。 */
export async function loadPrompts(path: string | URL = new URL('../../../system/prompts.json', import.meta.url)): Promise<PromptBundle> {
  return parsePrompts(JSON.parse(await readFile(path, 'utf8')));
}

/** 恢复出厂配置时读取示例，四份旧 Markdown 继续保留为历史验证来源。 */
export async function loadDefaultPrompts(): Promise<PromptBundle> {
  return loadPrompts(new URL('../../../system/prompts.example.json', import.meta.url));
}
