// SPDX-License-Identifier: MIT
import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';

function blocked(kind) {
  const file = process.env.BA00_NET_LOG;
  if (file) {
    try {
      appendFileSync(file, `${kind}\n`);
      // eslint-disable-next-line no-empty
    } catch {}
  }
  throw new Error(`BA-00 network blocked: ${kind}`);
}

net.Socket.prototype.connect = function connectBlocked() {
  return blocked('net.connect');
};
dns.lookup = function lookupBlocked() {
  return blocked('dns.lookup');
};
globalThis.fetch = async function fetchBlocked() {
  return blocked('fetch');
};
