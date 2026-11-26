// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';

export const PROJECT_STATUSES = ['idea', 'ready', 'in_progress', 'blocked', 'done', 'archived'];
export const TASK_STATUSES = ['idea', 'ready', 'in_progress', 'blocked', 'done', 'dropped'];
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PROJECT_ID = /^PRJ-\d{3,}$/;
export const TASK_ID = /^[A-Z][A-Z0-9]*(?:-\d+)+$/;
export const BACKLOG_REL = 'planning/backlog.md';
export const PROJECTS_REL = 'planning/projects';
export const PROJECT_HEADER =
  '| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |';

const lineText = (line) => line.replace(/\r$/u, '');
const heading = (line) => /^##\s+\S/u.test(lineText(line));

function projectSection(lines) {
  const start = lines.findIndex((line) => /^##\s+Projects\s*$/iu.test(lineText(line)));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !heading(lines[end])) end++;
  return { start, end };
}

function tasksSection(lines) {
  const start = lines.findIndex((line) => /^##\s+Tasks\s*$/u.test(lineText(line)));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !heading(lines[end])) end++;
  return { start, end };
}

export function parseBacklog(content) {
  const lines = String(content ?? '').split('\n');
  const section = projectSection(lines);
  if (!section) return [];
  const rows = [];
  for (let index = section.start + 1; index < section.end; index++) {
    const line = lineText(lines[index]);
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 6 || /^ID$/iu.test(cells[0])) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
    const link = /\[[^\]]*\]\(([^)]+)\)/u.exec(cells[5]);
    rows.push({
      id: cells[0],
      title: cells[1],
      purpose: cells[2],
      priority: cells[3],
      status: cells[4],
      file: link ? link[1].trim() : cells[5],
    });
  }
  return rows;
}

export function parseTasks(content) {
  const lines = String(content ?? '').split('\n');
  const section = tasksSection(lines);
  if (!section) return [];
  const tasks = [];
  for (let index = section.start + 1; index < section.end; index++) {
    const match = /^-\s+\[([^\]]+)\]\s+(\S+)\s+·\s+(.+)$/u.exec(lineText(lines[index]));
    if (!match || !TASK_STATUSES.includes(match[1])) continue;
    const dated = /^(.*?) \((\d{4}-\d{2}-\d{2})\)$/u.exec(match[3]);
    tasks.push({
      id: match[2],
      status: match[1],
      title: dated ? dated[1] : match[3],
      date: dated ? dated[2] : null,
    });
  }
  return tasks;
}

export async function projectDocument({ id, title, status, goal }) {
  const template = await readFile(new URL('../../../templates/vault/project.md', import.meta.url), 'utf8');
  const values = { ID: id, Title: title, status, purpose: goal };
  return template.replace(/<(ID|Title|status|purpose)>/gu, (_, key) => values[key]);
}

export async function backlogDocument() {
  return readFile(new URL('../../../templates/vault/backlog.md', import.meta.url), 'utf8');
}

export function taskIds(content) {
  const ids = [];
  for (const line of String(content ?? '').split('\n')) {
    const match = /^-\s+\[[^\]]*\]\s+(\S+)\s+·/u.exec(lineText(line));
    if (match) ids.push(match[1]);
  }
  return ids;
}

export function backlogRow({ id, title, purpose, priority, status, slug }) {
  const file = `[projects/${slug}.md](projects/${slug}.md)`;
  return `| ${id} | ${title} | ${purpose} | ${priority} | ${status} | ${file} |`;
}

export function nextProjectId(rows) {
  let highest = 0;
  for (const row of rows) {
    const match = /^PRJ-(\d{3,})$/u.exec(row.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `PRJ-${String(highest + 1).padStart(3, '0')}`;
}

export function nextTaskId(tasks, projectId) {
  let best = null;
  for (const task of tasks) {
    const match = /^(.*)-(\d+)$/u.exec(task.id);
    if (!match) continue;
    const number = Number(match[2]);
    if (!best || number > best.number) best = { prefix: match[1], number };
  }
  return best ? `${best.prefix}-${best.number + 1}` : `${projectId}-1`;
}

export function appendBacklogRow(content, row) {
  const lines = String(content ?? '').split('\n');
  const cr = content.includes('\r\n') ? '\r' : '';
  const section = projectSection(lines);
  const fresh = `${row}${cr}`;
  if (!section) {
    if (lines.at(-1) === '')
      lines.splice(
        lines.length - 1,
        0,
        cr,
        `## Projects${cr}`,
        cr,
        ...PROJECT_HEADER.split('\n').map((line) => `${line}${cr}`),
        fresh
      );
    else lines.push(cr, `## Projects${cr}`, cr, ...PROJECT_HEADER.split('\n').map((line) => `${line}${cr}`), fresh);
    return lines.join('\n');
  }
  let insertAt = -1;
  for (let index = section.start + 1; index < section.end; index++)
    if (lines[index].trim().startsWith('|')) insertAt = index;
  if (insertAt < 0) {
    lines.splice(section.start + 1, 0, cr, ...PROJECT_HEADER.split('\n').map((line) => `${line}${cr}`), fresh);
    return lines.join('\n');
  }
  lines.splice(insertAt + 1, 0, fresh);
  return lines.join('\n');
}

export function setUpdatedLine(content, date) {
  const lines = String(content ?? '').split('\n');
  const index = lines.findIndex((line) => /^Updated:/u.test(lineText(line)));
  if (index < 0) return content;
  const cr = lines[index].endsWith('\r') ? '\r' : '';
  lines[index] = `Updated: ${date}${cr}`;
  return lines.join('\n');
}

export function setBacklogStatus(content, id, status) {
  const lines = String(content ?? '').split('\n');
  const section = projectSection(lines);
  if (!section) return content;
  for (let index = section.start + 1; index < section.end; index++) {
    const line = lineText(lines[index]);
    if (!line.trim().startsWith('|')) continue;
    const parts = lines[index].split('|');
    if (parts.length < 7 || parts[1].trim() !== id) continue;
    const cell = parts[5];
    const leading = /^\s*/u.exec(cell)[0];
    const trailing = /\s*$/u.exec(cell)[0];
    parts[5] = `${leading}${status}${trailing}`;
    lines[index] = parts.join('|');
    return lines.join('\n');
  }
  return content;
}

export function appendTask(content, taskLine) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const cr = text.includes('\r\n') ? '\r' : '';
  const section = tasksSection(lines);
  if (!section) {
    const eol = cr ? '\r\n' : '\n';
    const base = text.endsWith('\n') ? `${text}${eol}` : `${text}${eol}${eol}`;
    return `${base}## Tasks${eol}${eol}${taskLine}${eol}`;
  }
  let insertAt = section.end;
  while (insertAt - 1 > section.start && lineText(lines[insertAt - 1]).trim() === '') insertAt--;
  if (insertAt === section.start + 1) lines.splice(insertAt, 0, cr, `${taskLine}${cr}`);
  else lines.splice(insertAt, 0, `${taskLine}${cr}`);
  return lines.join('\n');
}

export function setTaskStatus(content, id, status) {
  const lines = String(content ?? '').split('\n');
  const section = tasksSection(lines);
  if (!section) return content;
  for (let index = section.start + 1; index < section.end; index++) {
    const match = /^-\s+\[([^\]]+)\]\s+(\S+)\s+·\s+/u.exec(lineText(lines[index]));
    if (!match || match[2] !== id) continue;
    lines[index] = lines[index].replace(/^(-\s+\[)[^\]]*(\])/u, `$1${status}$2`);
    return lines.join('\n');
  }
  return content;
}

export function setProjectStatus(content, status) {
  const lines = String(content ?? '').split('\n');
  const firstHeading = lines.findIndex((line) => /^#\s+/u.test(lineText(line)));
  const firstSection = lines.findIndex((line) => /^##\s+/u.test(lineText(line)));
  const limit = firstSection < 0 ? lines.length : firstSection;
  const index = lines.slice(0, limit).findIndex((line) => /^Status:/u.test(lineText(line)));
  if (index >= 0) {
    const cr = lines[index].endsWith('\r') ? '\r' : '';
    lines[index] = `Status: ${status}${cr}`;
    return lines.join('\n');
  }
  const cr = content.includes('\r\n') ? '\r' : '';
  if (firstHeading < 0) {
    lines.splice(0, 0, `Status: ${status}${cr}`);
    return lines.join('\n');
  }
  lines.splice(firstHeading + 1, 0, `Status: ${status}${cr}`);
  return lines.join('\n');
}
