// SPDX-License-Identifier: MIT
// Loader hook used by the BA-07 tests: records every resolved URL under modules/semantic into BA07_TRACE.
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (process.env.BA07_TRACE && /modules\/semantic/u.test(result.url)) appendFileSync(process.env.BA07_TRACE, `${result.url}\n`);
  return result;
}
