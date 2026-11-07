// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, normalizeText, stem } from '../../../packages/core/src/retrieval/index.mjs';
test('retrieval contract provides ranked evidence', () => {
  const index = buildIndex([{path:'a.md',title:'Vault backup',aliases:[],keywords:[],headings:[],body:'Backup evidence',frontmatter:{status:'active'}}], {now:new Date('2025-01-01')});
  assert.equal(search(index,'backup').results[0].path,'a.md');
  assert.equal(normalizeText('İŞIĞI'), 'isigi');
  assert.equal(stem('backups'), 'backup');
});
