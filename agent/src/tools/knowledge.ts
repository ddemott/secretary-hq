import { llm } from '@livekit/agents';
import type { ToolMap } from './types.js';
import type { ToolBuildDeps } from './deps.js';
import { formatResponse } from './helpers.js';

export function knowledgeTools(d: ToolBuildDeps): ToolMap {
  const { ctx, client, speakFiller } = d;
  return {
    get_company_policy_answer: llm.tool({
      description:
        "Semantic search the knowledge base for policy/FAQ answers. Use BEFORE inventing any answer about hours, pricing, policies, warranties, etc. Returns plain text to read to the caller, or a fallback 'don't have that info' message.",
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: "The caller's question as a natural-language string.",
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      execute: async (args: { question: string }) => {
        speakFiller?.('Let me look that up for you...');
        const res = await client.call(
          '/agent-tools/policy-answer',
          {
            tenant_id: ctx.tenantId,
            question: args.question,
            // The gap row this may write (zero RAG hits) is the owner's
            // to-do. Without the call id it is an orphan: it cannot be
            // traced back to the call that produced it, and deleting the
            // call leaves the badge counting a question with no evidence
            // behind it (2026-09-09).
            call_id: ctx.callId || undefined,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
  };
}
