import type { AdoClient } from '../sdk/azure-devops-client.ts';
import {
  extractImageUrls,
  stripHtmlToText,
  type ExtractedImage,
} from '../utils/html.ts';

export interface WorkItemContextComment {
  author: string;
  createdDate: string;
  text: string;
}

export interface WorkItemContext {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  description: string;
  reproSteps: string;
  acceptanceCriteria: string;
  images: ExtractedImage[];
  comments: WorkItemContextComment[];
}

/**
 * Fetch a work item and its comment history, strip HTML from rich-text fields,
 * extract ADO attachment image URLs, and return a clean context shape suitable
 * for prompting the analyzer.
 */
export async function fetchWiContext(
  ado: AdoClient,
  workItemId: number,
): Promise<WorkItemContext> {
  const [wi, rawComments] = await Promise.all([
    ado.getWorkItem(workItemId),
    ado.getWorkItemComments(workItemId),
  ]);

  const fields = wi.fields;
  const description = fields['System.Description'] ?? '';
  const reproSteps = fields['Microsoft.VSTS.TCM.ReproSteps'] ?? '';
  const acceptanceCriteria =
    fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '';

  const allHtml = `${description}\n${reproSteps}\n${acceptanceCriteria}`;
  const images = extractImageUrls(allHtml);

  const comments: WorkItemContextComment[] = rawComments.map((c) => ({
    author:
      typeof c.createdBy === 'object' && c.createdBy
        ? (c.createdBy.displayName ?? '')
        : '',
    createdDate: c.createdDate ?? '',
    text: stripHtmlToText(c.text ?? ''),
  }));

  return {
    id: wi.id,
    title: fields['System.Title'] ?? `wi-${workItemId}`,
    workItemType: fields['System.WorkItemType'] ?? '',
    state: fields['System.State'] ?? '',
    description: stripHtmlToText(description),
    reproSteps: stripHtmlToText(reproSteps),
    acceptanceCriteria: stripHtmlToText(acceptanceCriteria),
    images,
    comments,
  };
}
