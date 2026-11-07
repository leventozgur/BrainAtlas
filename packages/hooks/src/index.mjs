// SPDX-License-Identifier: MIT
import { NotImplementedError } from '@brainatlas/core';
/** @param {{client:string,event:string,stdin:string,env:object,now:Date,config:object}} input @returns {Promise<{stdout:string,exitCode:number}>} */
export async function runHook(input) { throw new NotImplementedError('hooks.runHook'); }
