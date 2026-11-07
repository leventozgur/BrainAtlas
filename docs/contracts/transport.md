---
contract-version: 1
---
# Transport contract

## Purpose

Provide conditional object storage and, where selected, Git synchronization.

## Function signatures

```js
/** @returns {Promise<Array<{path:string,rev:string,size:number}>>} */
list(prefix);
/** @returns {Promise<{bytes:Uint8Array,rev:string}|null>} */
get(path);
/** @param {string} path @param {Uint8Array} bytes @param {{ifRev?:string,ifAbsent?:boolean}} options @returns {Promise<{rev:string}>} */
put(path, bytes, options);
/** @param {string} path @param {{ifRev:string}} options @returns {Promise<void>} */
delete(path, options);
/** @returns {Promise<void>} */
pull();
/** @param {string} message @returns {Promise<void>} */
commitAndPush(message);
/** @returns {Promise<object>} */
status();
/** @returns {ObjectTransport} */
createMemoryTransport();
```

`capabilities` is `{cas:boolean,mode:'object'|'git'}`. `ObjectTransport` consists of `list`, `get`, `put`, `delete`, and `capabilities`; Git mode adds `pull`, `commitAndPush`, and `status`.

## Input

Object keys are relative transport paths. `ifRev` is compare-and-swap against the current revision; `ifAbsent` requests create-only behavior. `bytes` is opaque content.

## Output and errors

`get` returns `null` when absent. `put` returns a new revision. Conditional mismatch raises `ConflictError` with `code:'E_CONFLICT'`. Error taxonomy: `E_AUTH`, `E_NETWORK`, `E_CONFLICT`, `E_QUOTA`, `E_NOT_FOUND`, and `E_DEGRADED`. `createMemoryTransport()` is an offline in-memory mock.

## Example

```js
const { rev } = await transport.put('notes/a.md', bytes, { ifAbsent: true });
```

## Security

Enforce vault scoping and path validation at the transport boundary. Errors and logs must not contain object bytes or page contents.

## Version

Object API is fixed in `modules/sync-engine/src/transport.mjs`. Git extensions use the same error taxonomy. Contract version 1.
