/**
 * Per-invocation git auth for Azure DevOps over HTTPS: an `http.extraHeader`
 * config argument carrying `Basic base64(":" + PAT)`. Passed as argv on each
 * call — never written to .git/config — so persisted remote URLs stay
 * credential-free. Harmless on file:// remotes (http.* config is ignored),
 * which keeps the real-git test sandboxes working unchanged.
 */
export function buildGitAuthArgs(pat: string): string[] {
  const basic = Buffer.from(`:${pat}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Strip the PAT (raw and base64 basic-auth forms) from text destined for
 * error messages, logs, or WI comments. The sibling repo leaked its PAT into
 * ADO comments through a git error message that embedded argv — any error
 * text derived from an authenticated git call must pass through here.
 */
export function redactPat(text: string, pat: string): string {
  if (!pat) return text;
  const basic = Buffer.from(`:${pat}`).toString('base64');
  let out = text.replaceAll(basic, '<redacted>');
  // Raw PATs are long random strings; skip short values so a test PAT like
  // "pat" can't mangle unrelated words ("path").
  if (pat.length >= 8) out = out.replaceAll(pat, '<redacted>');
  return out;
}
