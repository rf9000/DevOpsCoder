import type { CanUseToolFn } from '../pipeline/agent-stage.ts';

export interface BashAllowlistConfig {
  /**
   * RegExp patterns matched against the Bash command string.
   * If any pattern matches, the command is allowed (unless a deny pattern also matches).
   */
  allow: RegExp[];
  /**
   * RegExp patterns matched against the Bash command string.
   * If any pattern matches, the command is denied. Deny takes precedence over allow.
   */
  deny: RegExp[];
}

/**
 * Tokens that compose, substitute, or redirect shell commands. Any of these in the
 * raw command string would let a model bypass the allowlist — e.g. `git status && git push`
 * starts with an allowed prefix but smuggles in a denied verb. We deny outright when any
 * of these appear, accepting the (rare) false positive on quoted occurrences of these
 * characters in commit messages etc. — the model can phrase its commands without them.
 *
 * Tokens covered: `&&`, `||`, `;`, `|`, `$(`, backtick, `>`, `>>`, `<`, `<<`, and
 * newlines/carriage returns (a second command on a new line bypasses `^`-anchored rules).
 */
const SHELL_COMPOSITION_RE = /(?:&&|\|\||;|\||`|\$\(|>|<|\n|\r)/;

/**
 * Build a `CanUseToolFn` that enforces a strict allowlist + denylist on Bash tool calls.
 *
 * Semantics:
 * - Non-Bash tool calls (`Read`, `Edit`, etc.) are unconditionally allowed by this filter.
 *   Compose with other filters (e.g. `createPathEscapeFilter`) to constrain non-Bash tools.
 * - Bash commands containing shell composition (`&&`, `||`, `;`, `|`, `$()`, backticks,
 *   `>`, `<`, newlines) are denied outright. They would otherwise let a model bypass the
 *   allowlist by smuggling a denied verb after an allowed prefix.
 * - For simple (non-composed) Bash: if any `deny` pattern matches → deny. Else if any
 *   `allow` pattern matches → allow. Else → deny (allowlist semantics — anything not
 *   explicitly allowed is rejected).
 * - A Bash call without a `command` field is denied (defensive — unknown shape).
 */
export function createBashAllowlist(cfg: BashAllowlistConfig): CanUseToolFn {
  return async (toolName, input) => {
    if (toolName !== 'Bash') return { behavior: 'allow' };

    const command = typeof input.command === 'string' ? input.command : '';
    if (command.length === 0) {
      return { behavior: 'deny', message: 'Bash call has no command' };
    }

    if (SHELL_COMPOSITION_RE.test(command)) {
      return {
        behavior: 'deny',
        message: `Bash command uses shell composition (&&, ||, ;, |, backticks, $(), >, <, newlines) — denied to prevent allowlist bypass: ${command}`,
      };
    }

    for (const denyRe of cfg.deny) {
      if (denyRe.test(command)) {
        return {
          behavior: 'deny',
          message: `Bash command denied by policy: ${command}`,
        };
      }
    }
    for (const allowRe of cfg.allow) {
      if (allowRe.test(command)) {
        return { behavior: 'allow' };
      }
    }
    return {
      behavior: 'deny',
      message: `Bash command not in allowlist: ${command}`,
    };
  };
}
