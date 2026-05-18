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
 * Build a `CanUseToolFn` that enforces a strict allowlist + denylist on Bash tool calls.
 *
 * Semantics:
 * - Non-Bash tool calls (`Read`, `Edit`, etc.) are unconditionally allowed by this filter.
 *   Compose with other filters (e.g. `createPathEscapeFilter`) to constrain non-Bash tools.
 * - For Bash: if any `deny` pattern matches → deny. Else if any `allow` pattern matches → allow.
 *   Else → deny (allowlist semantics — anything not explicitly allowed is rejected).
 * - A Bash call without a `command` field is denied (defensive — unknown shape).
 */
export function createBashAllowlist(cfg: BashAllowlistConfig): CanUseToolFn {
  return async (toolName, input) => {
    if (toolName !== 'Bash') return { behavior: 'allow' };

    const command = typeof input.command === 'string' ? input.command : '';
    if (command.length === 0) {
      return { behavior: 'deny', message: 'Bash call has no command' };
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
