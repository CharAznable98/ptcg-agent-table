import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateOneMatch } from './validate-match.ts';
import type { MatchRecord } from '../apps/server/src/match.ts';
const root=resolve(import.meta.dirname,'..');
const input=JSON.parse(await readFile(join(root,'scenario-input.json'),'utf8')) as {initial:Pick<MatchRecord,'state'|'meta'>};
await validateOneMatch(root,input.initial.state.players.map(player=>player.opponentId!),input.initial);
