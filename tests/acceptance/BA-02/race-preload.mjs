// SPDX-License-Identifier: MIT
import fs from 'node:fs';

const arm = process.env.BA02_RACE_ARM;
const target = process.env.BA02_RACE_TARGET;
const op = process.env.BA02_RACE_OP ?? 'read';
const mode = process.env.BA02_RACE_MODE ?? 'delete';
const to = process.env.BA02_RACE_TO;
const log = process.env.BA02_RACE_LOG;

if (arm && target) {
  const realExists = fs.existsSync;
  const realRm = fs.rmSync;
  const realRename = fs.renameSync;
  const realAppend = fs.appendFileSync;
  const fire = (file) => {
    if (!String(file).endsWith(target) || !realExists(arm)) return;
    realRm(arm, { force: true });
    realAppend(log, `fired op=${op} mode=${mode}\n`);
    if (mode === 'delete') realRm(file, { force: true });
    else realRename(file, to);
  };
  const realRead = fs.readFileSync;
  const realLstat = fs.lstatSync;
  if (op === 'read')
    fs.readFileSync = function (file, ...rest) {
      fire(file);
      return realRead.call(this, file, ...rest);
    };
  if (op === 'lstat')
    fs.lstatSync = function (file, ...rest) {
      fire(file);
      return realLstat.call(this, file, ...rest);
    };
}
