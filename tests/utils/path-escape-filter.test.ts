import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { createPathEscapeFilter } from '../../src/utils/path-escape-filter.ts';

describe('createPathEscapeFilter', () => {
  const cwd = '/repos/worktrees/wi-101';

  it('allows tool calls other than Edit/Write/NotebookEdit', async () => {
    const filter = createPathEscapeFilter(cwd);
    expect((await filter('Read', { file_path: '/outside/x' })).behavior).toBe('allow');
    expect((await filter('Bash', { command: 'echo hi' })).behavior).toBe('allow');
    expect((await filter('Grep', { pattern: 'foo' })).behavior).toBe('allow');
  });

  it('allows Edit on a file inside cwd (relative path)', async () => {
    const filter = createPathEscapeFilter(cwd);
    const result = await filter('Edit', { file_path: 'src/app.ts' });
    expect(result.behavior).toBe('allow');
  });

  it('allows Write on an absolute path inside cwd', async () => {
    const filter = createPathEscapeFilter(cwd);
    const result = await filter('Write', { file_path: join(cwd, 'src', 'new.ts') });
    expect(result.behavior).toBe('allow');
  });

  it('denies Edit with `..` that escapes cwd', async () => {
    const filter = createPathEscapeFilter(cwd);
    const result = await filter('Edit', { file_path: '../../etc/passwd' });
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toContain('escapes cwd');
    }
  });

  it('denies Write with an absolute path outside cwd', async () => {
    const filter = createPathEscapeFilter(cwd);
    const result = await filter('Write', { file_path: '/etc/passwd' });
    expect(result.behavior).toBe('deny');
  });

  it('denies Edit/Write/NotebookEdit with no file_path field', async () => {
    const filter = createPathEscapeFilter(cwd);
    expect((await filter('Edit', {})).behavior).toBe('deny');
    expect((await filter('Write', {})).behavior).toBe('deny');
    expect((await filter('NotebookEdit', {})).behavior).toBe('deny');
  });
});
