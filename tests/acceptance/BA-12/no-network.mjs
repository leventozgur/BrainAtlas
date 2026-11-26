// SPDX-License-Identifier: MIT
import dns from 'node:dns';
import net from 'node:net';

const deny = () => {
  throw new Error('network disabled for the BA-12 blind test');
};
net.Socket.prototype.connect = deny;
dns.lookup = deny;
globalThis.fetch = deny;
