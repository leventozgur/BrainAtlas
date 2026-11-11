// SPDX-License-Identifier: MIT
// BA-12 blind test preload: any network attempt in the CLI child process throws.
import dns from 'node:dns';
import net from 'node:net';

const deny = () => { throw new Error('network disabled for the BA-12 blind test'); };
net.Socket.prototype.connect = deny;
dns.lookup = deny;
globalThis.fetch = deny;
