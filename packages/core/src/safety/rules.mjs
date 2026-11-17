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
  // BA-26: Azure Storage and Service Bus keys. A run of 20 identical characters is a placeholder, never a key.
  {
    id: 'azure-storage-key',
    pattern: /\b(?:AccountKey|SharedAccessKey)=(?!(.)\1{19})[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
  },
  // BA-26: shared access signature query (sv=<version date>&...&sig=<signature>), with or without a SharedAccessSignature= prefix.
  { id: 'azure-sas-token', pattern: /\bsv=\d{4}-\d{2}-\d{2}[^\s"'<>]{0,2048}?&sig=(?!(.)\1{19})[A-Za-z0-9%+/=]{20,}/g },
  // BA-26: an Authorization header bearer value of realistic length that contains a digit; ${...} and <...> never match.
  {
    id: 'bearer-token',
    pattern:
      /\bauthorization[ \t]*:[ \t]*bearer[ \t]+(?!(.)\1{19})(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
  },
  // BA-26: GitLab personal access token: glpat- followed by exactly 20 token characters.
  { id: 'gitlab-pat', pattern: /\bglpat-(?!(.)\1{19})[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/g },
  // BA-26: Azure DevOps PAT (52 base32 characters) only with azure/ado/pat key context; a bare string is not a finding.
  // The key must start with the keyword (azure, ado or pat) so that the engine only tries positions where it occurs; keys such as
  // my_ado_pat are not matched (narrower on purpose). Repetitions are bounded so that the match stays linear.
  {
    id: 'azure-devops-pat',
    pattern:
      /(?<![A-Za-z0-9])(?:azure|ado|pat)(?:[_.-][A-Za-z0-9]{1,32}){0,4}["']?[ \t]*[:=][ \t]*["']?(?!(.)\1{51})[a-z2-7]{52}(?![a-z2-7])/gi,
  },
  // BA-26: Azure DevOps PAT inside a dev.azure.com URL that carries a user:password pair.
  {
    id: 'azure-devops-pat',
    pattern: /\bhttps?:\/\/[^\s/:@]{0,256}:(?![$<{])(?!(.)\1{7})[^\s/@]{8,256}@dev\.azure\.com\b/gi,
  },
]);
// BA-26: personal-data findings (kind: 'personal'). Each rule must pass its checksum; a failing candidate is not a finding.
// Identifiers are rejected by surrounding digits so that longer numbers (timestamps, ids) never match.
// TCKN: 11 digits, first digit not 0, 10th and 11th digits from the official check algorithm.
function validTckn(value) {
  const d = [...value].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8],
    even = d[1] + d[3] + d[5] + d[7];
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (tenth !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
// TR IBAN: ISO 13616 mod-97 over the rearranged value (letters A=10 .. Z=35), spaces ignored.
function validIban(value) {
  const compact = value.replace(/ /g, '');
  if (compact.length !== 26 || !compact.startsWith('TR')) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let mod = 0;
  for (const ch of rearranged) {
    // Letters become two digits (A=10 .. Z=35); the country letters T and R become 29 and 27.
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of digits) mod = (mod * 10 + Number(digit)) % 97;
  }
  return mod === 1;
}
export const PERSONAL_RULES = Object.freeze([
  { id: 'tckn', pattern: /(?<![0-9])[1-9][0-9]{10}(?![0-9])/g, valid: validTckn },
  { id: 'tr-iban', pattern: /(?<![A-Za-z0-9])TR[0-9]{2}(?: ?[0-9]{4}){5} ?[0-9]{2}(?![0-9])/g, valid: validIban },
]);
// BA-26: contact data is redacted only in output (redact with the personal option); it never blocks a write.
export const CONTACT_RULES = Object.freeze([
  {
    id: 'email',
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![A-Za-z0-9-])/g,
  },
  {
    id: 'tr-phone',
    pattern: /(?<![A-Za-z0-9+])(?:\+90|0)[ -]?\(?[2-5][0-9]{2}\)?[ -]?[0-9]{3}[ -]?[0-9]{2}[ -]?[0-9]{2}(?![0-9])/g,
  },
]);
export const DENY_GLOBS = Object.freeze([
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '*.p12',
  '*.pfx',
  '.npmrc',
  '.netrc',
  'credentials*',
  'client_secret*',
  'secret',
  'secrets',
  'secret.md',
  'secrets.md',
  '*.secret',
  '*.secrets',
  '.git/**',
  '.ssh/**',
]);
