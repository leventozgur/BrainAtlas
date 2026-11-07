// SPDX-License-Identifier: MIT
export class BrainAtlasError extends Error {
  constructor(code, message, details = undefined) {
    super(message); this.name = 'BrainAtlasError'; this.code = code; this.details = details;
  }
}
export class NotImplementedError extends BrainAtlasError {
  constructor(operation) { super('E_NOT_IMPLEMENTED', `${operation} is not implemented`); this.name = 'NotImplementedError'; }
}
