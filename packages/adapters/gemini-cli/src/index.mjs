// SPDX-License-Identifier: MIT
import { NotImplementedError } from '@brainatlas/core';
export const id = 'gemini-cli';
export const displayName = 'Gemini CLI';
export function detect(env) { throw new NotImplementedError('adapter.detect'); }
export function plan(ctx) { throw new NotImplementedError('adapter.plan'); }
export function apply(planResult, ctx) { throw new NotImplementedError('adapter.apply'); }
export function remove(ctx) { throw new NotImplementedError('adapter.remove'); }
export function doctor(ctx) { throw new NotImplementedError('adapter.doctor'); }
export function trustReview(ctx) { throw new NotImplementedError('adapter.trustReview'); }
