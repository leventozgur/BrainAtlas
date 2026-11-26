// SPDX-License-Identifier: MIT
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (process.env.BA07_TRACE && /modules\/semantic/u.test(result.url))
    appendFileSync(process.env.BA07_TRACE, `${result.url}\n`);
  return result;
}
