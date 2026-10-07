import type { SuggestionInput } from '../../src/suggestions/input.ts';

export const HEAD = 'abc1234def5678abc1234def5678abc1234def56';

export function makeInput(overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    mode: 'pr',
    repository: 'Continia Banking',
    pullRequestId: 12345,
    parentPullRequestUrl: 'https://dev.azure.com/org/proj/_git/Continia%20Banking/pullrequest/12345',
    reviewerId: 'guid-creator',
    sourceRefName: 'refs/heads/feature/foo',
    headCommit: HEAD,
    runNo: 1003,
    suggestions: [
      {
        id: 'F001',
        file: 'Continia Banking/base-application-test/Auth/TestAuth.Codeunit.al',
        line: 68,
        title: 'F001: add-assert in SomeTest',
        description: 'Assert the target is empty.\n\nExpected effect: kills 2\nKills mutants: 140, 141',
        code: '        Assert.RecordIsEmpty(TempTarget);',
        confidence: 'high',
      },
    ],
    ...overrides,
  };
}
