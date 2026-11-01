import type { HumanActionInput, HumanActionView, HumanChoiceAnswer, PlayerId } from '../../../packages/protocol/src/index.ts';
import { api, jsonBody } from './api.ts';

export const startHumanAction = (matchId: string, input: HumanActionInput) => api<HumanActionView>(`/matches/${matchId}/actions`, { method: 'POST', body: jsonBody(input) });
export const activateHumanTurn = (matchId: string, playerId: PlayerId) => api<HumanActionView | null>(`/matches/${matchId}/actions/activate`, { method: 'POST', body: jsonBody({ playerId }) });
export const answerHumanChoice = (matchId: string, actionId: string, answer: HumanChoiceAnswer) => api<HumanActionView>(`/matches/${matchId}/actions/${actionId}/choice`, { method: 'POST', body: jsonBody(answer) });
export const controlHumanAction = (matchId: string, actionId: string, playerId: PlayerId, action: 'retry' | 'cancel' | 'repair' | 'manual') => api<HumanActionView>(`/matches/${matchId}/actions/${actionId}/control`, { method: 'POST', body: jsonBody({ playerId, action }) });
