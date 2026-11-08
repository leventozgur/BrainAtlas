# Dependency license inventory

Source: each external package entry in package-lock.json, including nested installs. Versions are from the lockfile; license values are read from the installed package’s package.json. Workspace links are excluded from this npm inventory; the vendored workspace is covered in notices-check.md.

The approved-root path column records a shortest transitive path from one of @modelcontextprotocol/sdk, yaml, gray-matter, zod. External package instances outside these roots: 0.

All 123 package entries (including workspace links and nested installs) have hasInstallScript absent or false; no true markers were found.

Inventory covers 106 external package instances (102 distinct names).

| Package | Version | license | Approved-root path | Installed lock path | Lite prod | Full prod | License review |
|---|---:|---|---|---|:---:|:---:|---|
| @hono/node-server | 2.1.6 | MIT | @modelcontextprotocol/sdk > @hono/node-server | node_modules/@hono/node-server | yes | yes | — |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | @modelcontextprotocol/sdk | node_modules/@modelcontextprotocol/sdk | yes | yes | — |
| accepts | 2.0.0 | MIT | @modelcontextprotocol/sdk > express > accepts | node_modules/accepts | yes | yes | — |
| ajv | 8.20.0 | MIT | @modelcontextprotocol/sdk > ajv | node_modules/ajv | yes | yes | — |
| ajv-formats | 3.0.1 | MIT | @modelcontextprotocol/sdk > ajv-formats | node_modules/ajv-formats | yes | yes | — |
| argparse | 1.0.10 | MIT | gray-matter > js-yaml > argparse | node_modules/argparse | yes | yes | — |
| body-parser | 2.4.0 | MIT | @modelcontextprotocol/sdk > express > body-parser | node_modules/body-parser | yes | yes | — |
| content-type | 2.1.0 | MIT | @modelcontextprotocol/sdk > express > body-parser > content-type (nested) | node_modules/body-parser/node_modules/content-type | yes | yes | — |
| bytes | 3.1.2 | MIT | @modelcontextprotocol/sdk > raw-body > bytes | node_modules/bytes | yes | yes | — |
| call-bind-apply-helpers | 1.0.2 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > call-bound > call-bind-apply-helpers | node_modules/call-bind-apply-helpers | yes | yes | — |
| call-bound | 1.0.4 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > call-bound | node_modules/call-bound | yes | yes | — |
| content-disposition | 2.0.1 | MIT | @modelcontextprotocol/sdk > express > content-disposition | node_modules/content-disposition | yes | yes | — |
| content-type | 1.0.5 | MIT | @modelcontextprotocol/sdk > content-type | node_modules/content-type | yes | yes | — |
| cookie | 0.7.2 | MIT | @modelcontextprotocol/sdk > express > cookie | node_modules/cookie | yes | yes | — |
| cookie-signature | 1.2.2 | MIT | @modelcontextprotocol/sdk > express > cookie-signature | node_modules/cookie-signature | yes | yes | — |
| cors | 2.8.6 | MIT | @modelcontextprotocol/sdk > cors | node_modules/cors | yes | yes | — |
| cross-spawn | 7.0.6 | MIT | @modelcontextprotocol/sdk > cross-spawn | node_modules/cross-spawn | yes | yes | — |
| debug | 4.4.3 | MIT | @modelcontextprotocol/sdk > express > debug | node_modules/debug | yes | yes | — |
| depd | 2.0.0 | MIT | @modelcontextprotocol/sdk > express > depd | node_modules/depd | yes | yes | — |
| dunder-proto | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > get-proto > dunder-proto | node_modules/dunder-proto | yes | yes | — |
| ee-first | 1.1.1 | MIT | @modelcontextprotocol/sdk > express > on-finished > ee-first | node_modules/ee-first | yes | yes | — |
| encodeurl | 2.0.1 | MIT | @modelcontextprotocol/sdk > express > encodeurl | node_modules/encodeurl | yes | yes | — |
| es-define-property | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > qs > es-define-property | node_modules/es-define-property | yes | yes | — |
| es-errors | 1.3.0 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > es-errors | node_modules/es-errors | yes | yes | — |
| es-object-atoms | 1.1.2 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > es-object-atoms | node_modules/es-object-atoms | yes | yes | — |
| escape-html | 1.0.3 | MIT | @modelcontextprotocol/sdk > express > escape-html | node_modules/escape-html | yes | yes | — |
| esprima | 4.0.1 | BSD-2-Clause | gray-matter > js-yaml > esprima | node_modules/esprima | yes | yes | — |
| etag | 1.8.1 | MIT | @modelcontextprotocol/sdk > express > etag | node_modules/etag | yes | yes | — |
| eventsource | 3.0.7 | MIT | @modelcontextprotocol/sdk > eventsource | node_modules/eventsource | yes | yes | — |
| eventsource-parser | 3.1.1 | MIT | @modelcontextprotocol/sdk > eventsource-parser | node_modules/eventsource-parser | yes | yes | — |
| express | 5.3.0 | MIT | @modelcontextprotocol/sdk > express | node_modules/express | yes | yes | — |
| express-rate-limit | 8.7.3 | MIT | @modelcontextprotocol/sdk > express-rate-limit | node_modules/express-rate-limit | yes | yes | — |
| content-type | 2.1.0 | MIT | @modelcontextprotocol/sdk > express > content-type (nested) | node_modules/express/node_modules/content-type | yes | yes | — |
| extend-shallow | 2.0.1 | MIT | gray-matter > section-matter > extend-shallow | node_modules/extend-shallow | yes | yes | — |
| fast-deep-equal | 3.1.3 | MIT | @modelcontextprotocol/sdk > ajv > fast-deep-equal | node_modules/fast-deep-equal | yes | yes | — |
| fast-uri | 3.1.9 | BSD-3-Clause | @modelcontextprotocol/sdk > ajv > fast-uri | node_modules/fast-uri | yes | yes | — |
| finalhandler | 2.1.1 | MIT | @modelcontextprotocol/sdk > express > finalhandler | node_modules/finalhandler | yes | yes | — |
| forwarded | 0.2.0 | MIT | @modelcontextprotocol/sdk > express > proxy-addr > forwarded | node_modules/forwarded | yes | yes | — |
| fresh | 2.0.0 | MIT | @modelcontextprotocol/sdk > express > fresh | node_modules/fresh | yes | yes | — |
| function-bind | 1.1.2 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > function-bind | node_modules/function-bind | yes | yes | — |
| get-intrinsic | 1.3.0 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic | node_modules/get-intrinsic | yes | yes | — |
| get-proto | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > get-proto | node_modules/get-proto | yes | yes | — |
| gopd | 1.2.0 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > gopd | node_modules/gopd | yes | yes | — |
| gray-matter | 4.0.3 | MIT | gray-matter | node_modules/gray-matter | yes | yes | — |
| has-symbols | 1.1.0 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > has-symbols | node_modules/has-symbols | yes | yes | — |
| hasown | 2.0.4 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > hasown | node_modules/hasown | yes | yes | — |
| hono | 4.13.17 | MIT | @modelcontextprotocol/sdk > hono | node_modules/hono | yes | yes | — |
| http-errors | 2.0.1 | MIT | @modelcontextprotocol/sdk > express > http-errors | node_modules/http-errors | yes | yes | — |
| iconv-lite | 0.7.3 | MIT | @modelcontextprotocol/sdk > raw-body > iconv-lite | node_modules/iconv-lite | yes | yes | — |
| inherits | 2.0.4 | ISC | @modelcontextprotocol/sdk > express > http-errors > inherits | node_modules/inherits | yes | yes | — |
| ip-address | 10.7.6 | MIT | @modelcontextprotocol/sdk > express-rate-limit > ip-address | node_modules/ip-address | yes | yes | — |
| ipaddr.js | 1.9.1 | MIT | @modelcontextprotocol/sdk > express > proxy-addr > ipaddr.js | node_modules/ipaddr.js | yes | yes | — |
| is-extendable | 0.1.1 | MIT | gray-matter > section-matter > extend-shallow > is-extendable | node_modules/is-extendable | yes | yes | — |
| is-promise | 4.0.0 | MIT | @modelcontextprotocol/sdk > express > router > is-promise | node_modules/is-promise | yes | yes | — |
| isexe | 2.0.0 | ISC | @modelcontextprotocol/sdk > cross-spawn > which > isexe | node_modules/isexe | yes | yes | — |
| jose | 6.2.15 | MIT | @modelcontextprotocol/sdk > jose | node_modules/jose | yes | yes | — |
| js-yaml | 3.15.2 | MIT | gray-matter > js-yaml | node_modules/js-yaml | yes | yes | — |
| json-schema-traverse | 1.0.0 | MIT | @modelcontextprotocol/sdk > ajv > json-schema-traverse | node_modules/json-schema-traverse | yes | yes | — |
| json-schema-typed | 8.0.2 | BSD-2-Clause | @modelcontextprotocol/sdk > json-schema-typed | node_modules/json-schema-typed | yes | yes | — |
| kind-of | 6.0.3 | MIT | gray-matter > kind-of | node_modules/kind-of | yes | yes | — |
| math-intrinsics | 1.1.0 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map > get-intrinsic > math-intrinsics | node_modules/math-intrinsics | yes | yes | — |
| media-typer | 1.1.1 | MIT | @modelcontextprotocol/sdk > express > type-is > media-typer | node_modules/media-typer | yes | yes | — |
| merge-descriptors | 2.0.0 | MIT | @modelcontextprotocol/sdk > express > merge-descriptors | node_modules/merge-descriptors | yes | yes | — |
| mime-db | 1.54.0 | MIT | @modelcontextprotocol/sdk > express > mime-types > mime-db | node_modules/mime-db | yes | yes | — |
| mime-types | 3.0.2 | MIT | @modelcontextprotocol/sdk > express > mime-types | node_modules/mime-types | yes | yes | — |
| ms | 2.1.3 | MIT | @modelcontextprotocol/sdk > express > debug > ms | node_modules/ms | yes | yes | — |
| negotiator | 1.1.0 | MIT | @modelcontextprotocol/sdk > express > accepts > negotiator | node_modules/negotiator | yes | yes | — |
| content-type | 2.1.0 | MIT | @modelcontextprotocol/sdk > express > accepts > negotiator > content-type (nested) | node_modules/negotiator/node_modules/content-type | yes | yes | — |
| object-assign | 4.1.1 | MIT | @modelcontextprotocol/sdk > cors > object-assign | node_modules/object-assign | yes | yes | — |
| object-inspect | 1.13.4 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > object-inspect | node_modules/object-inspect | yes | yes | — |
| on-finished | 2.4.2 | MIT | @modelcontextprotocol/sdk > express > on-finished | node_modules/on-finished | yes | yes | — |
| once | 1.4.0 | ISC | @modelcontextprotocol/sdk > express > once | node_modules/once | yes | yes | — |
| parseurl | 1.3.3 | MIT | @modelcontextprotocol/sdk > express > parseurl | node_modules/parseurl | yes | yes | — |
| path-key | 3.1.1 | MIT | @modelcontextprotocol/sdk > cross-spawn > path-key | node_modules/path-key | yes | yes | — |
| path-to-regexp | 8.4.2 | MIT | @modelcontextprotocol/sdk > express > router > path-to-regexp | node_modules/path-to-regexp | yes | yes | — |
| pkce-challenge | 5.0.1 | MIT | @modelcontextprotocol/sdk > pkce-challenge | node_modules/pkce-challenge | yes | yes | — |
| proxy-addr | 2.0.8 | MIT | @modelcontextprotocol/sdk > express > proxy-addr | node_modules/proxy-addr | yes | yes | — |
| qs | 6.17.1 | BSD-3-Clause | @modelcontextprotocol/sdk > express > qs | node_modules/qs | yes | yes | — |
| range-parser | 1.3.0 | MIT | @modelcontextprotocol/sdk > express > range-parser | node_modules/range-parser | yes | yes | — |
| raw-body | 3.0.2 | MIT | @modelcontextprotocol/sdk > raw-body | node_modules/raw-body | yes | yes | — |
| require-from-string | 2.0.2 | MIT | @modelcontextprotocol/sdk > ajv > require-from-string | node_modules/require-from-string | yes | yes | — |
| router | 2.2.0 | MIT | @modelcontextprotocol/sdk > express > router | node_modules/router | yes | yes | — |
| safer-buffer | 2.1.2 | MIT | @modelcontextprotocol/sdk > raw-body > iconv-lite > safer-buffer | node_modules/safer-buffer | yes | yes | — |
| section-matter | 1.0.0 | MIT | gray-matter > section-matter | node_modules/section-matter | yes | yes | — |
| send | 1.2.1 | MIT | @modelcontextprotocol/sdk > express > send | node_modules/send | yes | yes | — |
| serve-static | 2.2.1 | MIT | @modelcontextprotocol/sdk > express > serve-static | node_modules/serve-static | yes | yes | — |
| setprototypeof | 1.2.0 | ISC | @modelcontextprotocol/sdk > express > http-errors > setprototypeof | node_modules/setprototypeof | yes | yes | — |
| shebang-command | 2.0.0 | MIT | @modelcontextprotocol/sdk > cross-spawn > shebang-command | node_modules/shebang-command | yes | yes | — |
| shebang-regex | 3.0.0 | MIT | @modelcontextprotocol/sdk > cross-spawn > shebang-command > shebang-regex | node_modules/shebang-regex | yes | yes | — |
| side-channel | 1.1.1 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel | node_modules/side-channel | yes | yes | — |
| side-channel-list | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-list | node_modules/side-channel-list | yes | yes | — |
| side-channel-map | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-map | node_modules/side-channel-map | yes | yes | — |
| side-channel-weakmap | 1.0.2 | MIT | @modelcontextprotocol/sdk > express > qs > side-channel > side-channel-weakmap | node_modules/side-channel-weakmap | yes | yes | — |
| sprintf-js | 1.0.3 | BSD-3-Clause | gray-matter > js-yaml > argparse > sprintf-js | node_modules/sprintf-js | yes | yes | — |
| statuses | 2.0.2 | MIT | @modelcontextprotocol/sdk > express > statuses | node_modules/statuses | yes | yes | — |
| strip-bom-string | 1.0.0 | MIT | gray-matter > strip-bom-string | node_modules/strip-bom-string | yes | yes | — |
| toidentifier | 1.0.1 | MIT | @modelcontextprotocol/sdk > express > http-errors > toidentifier | node_modules/toidentifier | yes | yes | — |
| type-is | 2.1.0 | MIT | @modelcontextprotocol/sdk > express > type-is | node_modules/type-is | yes | yes | — |
| content-type | 2.1.0 | MIT | @modelcontextprotocol/sdk > express > type-is > content-type (nested) | node_modules/type-is/node_modules/content-type | yes | yes | — |
| unpipe | 1.0.0 | MIT | @modelcontextprotocol/sdk > raw-body > unpipe | node_modules/unpipe | yes | yes | — |
| vary | 1.1.2 | MIT | @modelcontextprotocol/sdk > cors > vary | node_modules/vary | yes | yes | — |
| which | 2.0.2 | ISC | @modelcontextprotocol/sdk > cross-spawn > which | node_modules/which | yes | yes | — |
| wrappy | 1.0.2 | ISC | @modelcontextprotocol/sdk > express > once > wrappy | node_modules/wrappy | yes | yes | — |
| yaml | 2.9.1 | ISC | yaml | node_modules/yaml | yes | yes | — |
| zod | 4.6.7 | MIT | zod | node_modules/zod | yes | yes | — |
| zod-to-json-schema | 3.25.2 | ISC | @modelcontextprotocol/sdk > zod-to-json-schema | node_modules/zod-to-json-schema | yes | yes | — |

## Release production package sets

Derived from release/build-release.mjs dependency traversal: included package manifests enqueue dependencies only. Lite input roots are package.json, packages/core, packages/mcp, packages/hooks, packages/cli, packages/adapters, vendor, templates, release/allowed_signers. Full adds manifest-bearing modules/* directories. Workspace package names are omitted below.

- **Lite: 102 external production packages**

@hono/node-server, @modelcontextprotocol/sdk, accepts, ajv, ajv-formats, argparse, body-parser, bytes, call-bind-apply-helpers, call-bound, content-disposition, content-type, cookie, cookie-signature, cors, cross-spawn, debug, depd, dunder-proto, ee-first, encodeurl, es-define-property, es-errors, es-object-atoms, escape-html, esprima, etag, eventsource, eventsource-parser, express, express-rate-limit, extend-shallow, fast-deep-equal, fast-uri, finalhandler, forwarded, fresh, function-bind, get-intrinsic, get-proto, gopd, gray-matter, has-symbols, hasown, hono, http-errors, iconv-lite, inherits, ip-address, ipaddr.js, is-extendable, is-promise, isexe, jose, js-yaml, json-schema-traverse, json-schema-typed, kind-of, math-intrinsics, media-typer, merge-descriptors, mime-db, mime-types, ms, negotiator, object-assign, object-inspect, on-finished, once, parseurl, path-key, path-to-regexp, pkce-challenge, proxy-addr, qs, range-parser, raw-body, require-from-string, router, safer-buffer, section-matter, send, serve-static, setprototypeof, shebang-command, shebang-regex, side-channel, side-channel-list, side-channel-map, side-channel-weakmap, sprintf-js, statuses, strip-bom-string, toidentifier, type-is, unpipe, vary, which, wrappy, yaml, zod, zod-to-json-schema

- **Full: 102 external production packages**

@hono/node-server, @modelcontextprotocol/sdk, accepts, ajv, ajv-formats, argparse, body-parser, bytes, call-bind-apply-helpers, call-bound, content-disposition, content-type, cookie, cookie-signature, cors, cross-spawn, debug, depd, dunder-proto, ee-first, encodeurl, es-define-property, es-errors, es-object-atoms, escape-html, esprima, etag, eventsource, eventsource-parser, express, express-rate-limit, extend-shallow, fast-deep-equal, fast-uri, finalhandler, forwarded, fresh, function-bind, get-intrinsic, get-proto, gopd, gray-matter, has-symbols, hasown, hono, http-errors, iconv-lite, inherits, ip-address, ipaddr.js, is-extendable, is-promise, isexe, jose, js-yaml, json-schema-traverse, json-schema-typed, kind-of, math-intrinsics, media-typer, merge-descriptors, mime-db, mime-types, ms, negotiator, object-assign, object-inspect, on-finished, once, parseurl, path-key, path-to-regexp, pkce-challenge, proxy-addr, qs, range-parser, raw-body, require-from-string, router, safer-buffer, section-matter, send, serve-static, setprototypeof, shebang-command, shebang-regex, side-channel, side-channel-list, side-channel-map, side-channel-weakmap, sprintf-js, statuses, strip-bom-string, toidentifier, type-is, unpipe, vary, which, wrappy, yaml, zod, zod-to-json-schema

- Full also contains the workspace production dependency @brainatlas/module-sync-engine; it adds no external npm packages beyond Lite.
