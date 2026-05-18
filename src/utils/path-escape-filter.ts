import { isAbsolute, relative, resolve } from 'path';
import type { CanUseToolFn } from '../pipeline/agent-stage.ts';

const RESTRICTED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Build a `CanUseToolFn` that rejects file-modifying tool calls whose target path
 * resolves outside `cwd`. Belt-and-suspenders safety on top of the SDK's `cwd`.
 *
 * Semantics:
 * - Non-restricted tools (`Read`, `Bash`, `Grep`, etc.) are unconditionally allowed.
 *   Use `createBashAllowlist` to constrain Bash separately.
 * - For `Edit`, `Write`, `NotebookEdit`: resolves `input.file_path` against `cwd`.
 *   If the resolved absolute path falls outside the `cwd` directory tree → deny.
 *   A missing `file_path` field is denied (defensive).
 */
export function createPathEscapeFilter(cwd: string): CanUseToolFn {
  const cwdResolved = resolve(cwd);
  return async (toolName, input) => {
    if (!RESTRICTED_TOOLS.has(toolName)) return { behavior: 'allow' };

    const filePath = typeof input.file_path === 'string' ? input.file_path : null;
    if (!filePath) {
      return {
        behavior: 'deny',
        message: `${toolName} call has no file_path`,
      };
    }

    const absoluteTarget = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(cwdResolved, filePath);
    const rel = relative(cwdResolved, absoluteTarget);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        behavior: 'deny',
        message: `path escapes cwd: ${filePath} (cwd: ${cwd})`,
      };
    }
    return { behavior: 'allow' };
  };
}
