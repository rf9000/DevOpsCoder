import { describe, it, expect, mock } from 'bun:test';
import { fetchWiContext } from '../../src/services/wi-context.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { WorkItem, WorkItemComment } from '../../src/types/index.ts';

function makeAdo(overrides: Partial<AdoClient> = {}): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => []),
    getWorkItem: mock(async () => ({ id: 0, fields: {} }) satisfies WorkItem),
    getWorkItemComments: mock(async () => [] satisfies WorkItemComment[]),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    ...overrides,
  };
}

describe('fetchWiContext', () => {
  it('combines getWorkItem + getWorkItemComments into a flat context shape', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({
        id: 101,
        fields: {
          'System.Title': 'Fix login',
          'System.State': 'Active',
          'System.WorkItemType': 'Bug',
          'System.Description': '<p>The login button is broken</p>',
          'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>step 1</li><li>step 2</li></ol>',
          'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Button works</p>',
        },
      })),
      getWorkItemComments: mock(async () => [
        {
          id: 1,
          text: '<p>I tried it on Chrome</p>',
          createdDate: '2026-01-01T10:00:00Z',
          createdBy: { displayName: 'Alice' },
        },
      ]),
    });
    const ctx = await fetchWiContext(ado, 101);
    expect(ctx.id).toBe(101);
    expect(ctx.title).toBe('Fix login');
    expect(ctx.state).toBe('Active');
    expect(ctx.workItemType).toBe('Bug');
    expect(ctx.description).toBe('The login button is broken');
    expect(ctx.reproSteps).toContain('- step 1');
    expect(ctx.reproSteps).toContain('- step 2');
    expect(ctx.acceptanceCriteria).toBe('Button works');
    expect(ctx.comments).toHaveLength(1);
    expect(ctx.comments[0]?.author).toBe('Alice');
    expect(ctx.comments[0]?.createdDate).toBe('2026-01-01T10:00:00Z');
    expect(ctx.comments[0]?.text).toBe('I tried it on Chrome');
    expect(ado.getWorkItem).toHaveBeenCalledWith(101);
    expect(ado.getWorkItemComments).toHaveBeenCalledWith(101);
  });

  it('extracts ADO attachment image URLs across description / repro / AC', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({
        id: 101,
        fields: {
          'System.Title': 't',
          'System.Description':
            '<p><img src="https://dev.azure.com/org/_apis/wit/attachments/a" alt="desc-img" /></p>',
          'Microsoft.VSTS.TCM.ReproSteps':
            '<img src="https://dev.azure.com/org/_apis/wit/attachments/b" alt="repro-img" />',
          'Microsoft.VSTS.Common.AcceptanceCriteria':
            '<img src="https://dev.azure.com/org/_apis/wit/attachments/c" alt="ac-img" />',
        },
      })),
    });
    const ctx = await fetchWiContext(ado, 101);
    expect(ctx.images).toHaveLength(3);
    const alts = ctx.images.map((i) => i.alt).sort();
    expect(alts).toEqual(['ac-img', 'desc-img', 'repro-img']);
  });

  it('handles missing description / reproSteps / acceptanceCriteria gracefully', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({
        id: 101,
        fields: { 'System.Title': 'Sparse' },
      })),
    });
    const ctx = await fetchWiContext(ado, 101);
    expect(ctx.description).toBe('');
    expect(ctx.reproSteps).toBe('');
    expect(ctx.acceptanceCriteria).toBe('');
    expect(ctx.images).toEqual([]);
    expect(ctx.comments).toEqual([]);
    expect(ctx.workItemType).toBe('');
    expect(ctx.state).toBe('');
  });

  it('falls back to "wi-{id}" title when System.Title is absent', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({ id: 42, fields: {} })),
    });
    const ctx = await fetchWiContext(ado, 42);
    expect(ctx.title).toBe('wi-42');
  });
});
