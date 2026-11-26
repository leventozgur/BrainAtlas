// SPDX-License-Identifier: MIT
export const OPERATIONS = Object.freeze([
  {
    tool: 'wiki_query',
    cli: 'wiki query <text>',
    kind: 'read',
    summary: 'Search verified Wiki evidence and return ranked snippets; compact omits the snippets.',
  },
  {
    tool: 'wiki_read_page',
    cli: 'wiki read <path>',
    kind: 'read',
    summary: 'Read a bounded Wiki page, or one of its sections by anchor.',
  },
  { tool: 'wiki_list_pages', cli: 'wiki list', kind: 'read', summary: 'List Wiki Markdown page paths.' },
  { tool: 'wiki_status', cli: 'wiki status', kind: 'read', summary: 'Read Wiki counts and health summary.' },
  { tool: 'wiki_lint', cli: 'wiki lint', kind: 'read', summary: 'Run the vendored Wiki quality checks.' },
  {
    tool: 'wiki_write_page',
    cli: 'wiki write <path>',
    kind: 'write',
    summary: 'Create or replace a Wiki page.',
  },
  { tool: 'wiki_update_page', cli: 'wiki update <path>', kind: 'write', summary: 'Update a Wiki page.' },
  {
    tool: 'wiki_create',
    cli: 'wiki create <entity|concept> <name>',
    kind: 'write',
    summary: 'Create an entity, concept, source, summary or query page from its template.',
  },
  {
    tool: 'wiki_add_crosslinks',
    cli: 'wiki link <path>',
    kind: 'write',
    summary: 'Add links to existing pages referenced by this page.',
  },
  {
    tool: 'wiki_update_index',
    cli: 'wiki reindex',
    kind: 'write',
    summary: 'Add missing pages to the Wiki index and remove entries for deleted pages; existing lines are kept.',
  },
  {
    tool: 'plan_read',
    cli: 'plan list',
    kind: 'read',
    summary: 'Read the planning backlog or one project file.',
  },
  {
    tool: 'plan_update',
    cli: 'plan new|add|set',
    kind: 'write',
    summary: 'Create a project, add a task, or set a project or task status.',
  },
]);

export const toolNames = () => OPERATIONS.map(({ tool }) => tool);
export const cliCommands = () => OPERATIONS.map(({ cli }) => cli);
