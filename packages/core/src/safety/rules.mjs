// SPDX-License-Identifier: MIT
// Rule IDs are part of the public finding and redaction format.
export const CONTENT_RULES = Object.freeze([
  { id: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { id: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { id: 'slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'google', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { id: 'cloud-storage-token', pattern: /\bsl\.[A-Za-z0-9_-]{20,}/g },
  { id: 'stripe', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { id: 'npm', pattern: /\bnpm_[A-Za-z0-9]{20,}/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { id: 'connection-credentials', pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{0,256}:[^\s/@]{1,256}@/gi },
]);
export const DENY_GLOBS = Object.freeze([
  '.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.p12', '*.pfx',
  '.npmrc', '.netrc', 'credentials*', 'client_secret*', 'secret', 'secrets',
  'secret.md', 'secrets.md', '*.secret', '*.secrets', '.git/**', '.ssh/**',
]);
