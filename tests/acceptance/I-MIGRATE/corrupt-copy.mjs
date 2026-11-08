// Test-only fault injection: corrupt one destination page immediately after its copy.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.writeFile;
fs.promises.writeFile = async function (path, data, options) {
  if (String(path) === process.env.TEST_CORRUPT_PATH) {
    const bytes = Buffer.from(data);
    bytes[bytes.length - 2] ^= 1;
    return original.call(this, path, bytes, options);
  }
  return original.call(this, path, data, options);
};
syncBuiltinESMExports();
