/**
 * Inventory: every tool buildTools defines vs what a question-tree call can reach.
 *
 * 5W:
 *   WHO  — the live ChecklistAgent path (ENABLE_QUESTION_TREE, production)
 *   WHAT — the set of tools the model can actually invoke on a tree call
 *   WHEN — every agent CI run
 *   WHERE— agent/src/tools.ts CAPABILITY_OF + checklist TREE_PASSTHROUGH_TOOLS
 *          + trees.ts action nodes
 *   WHY  — 26 tools lived in one file; selectedTools() only offered a subset.
 *          A tool that exists but is never selected is not a bug by itself —
 *          deleting it without a product call is. This test makes the gap
 *          visible and refuses silent drift.
 */
import { describe, it, expect } from 'vitest';
import { buildTools, CAPABILITY_OF, type Capability } from '../tools.js';
import {
  ALWAYS_ON_PASSTHROUGH_TOOLS,
  TREE_PASSTHROUGH_TOOLS,
} from '../checklist/checklistTools.js';
import { PLATFORM_TREE_LIBRARY } from '../checklist/trees.js';
import { DEFINED_UNREACHABLE_ON_QUESTION_TREE } from './reachability.js';
import type { ToolsClient } from '../toolsClient.js';
import type { SessionContext } from '../sessionContext.js';
import type { QuestionNodeDef } from '../checklist/types.js';

function makeClient(): ToolsClient {
  return { call: async () => ({ ok: true, result: {} }) } as unknown as ToolsClient;
}

function makeCtx(): SessionContext {
  return {
    tenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    callerPhone: '+155****4567',
    callId: 'sip-call-123',
    roomName: 'sip-room-1',
    participantIdentity: 'sip_participant_1',
  };
}

const ALL_CAPABILITIES: Capability[] = [
  'knowledge',
  'messaging',
  'identity',
  'scheduling',
  'verification',
  'transfer',
  'sms',
];

function collectActionTools(nodes: readonly QuestionNodeDef[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'action') into.add(node.tool);
    if (node.type === 'choice') {
      for (const children of Object.values(node.options)) collectActionTools(children, into);
    }
  }
}

function treeActionTools(): string[] {
  const names = new Set<string>();
  for (const tree of PLATFORM_TREE_LIBRARY) collectActionTools(tree.nodes, names);
  return [...names].sort();
}

function treePassthroughTools(): string[] {
  return [...new Set(Object.values(TREE_PASSTHROUGH_TOOLS).flat())].sort();
}

/** Tools from tools.ts that selectedTools() can offer (actions + passthroughs + always-on). */
function questionTreeReachableFromToolsTs(): string[] {
  return [
    ...new Set([...treeActionTools(), ...treePassthroughTools(), ...ALWAYS_ON_PASSTHROUGH_TOOLS]),
  ].sort();
}

describe('CAPABILITY_OF covers the live tool inventory', () => {
  it('HAPPY: every buildTools name has a capability, and every capability name exists', () => {
    const defined = Object.keys(buildTools(makeCtx(), makeClient())).sort();
    expect(Object.keys(CAPABILITY_OF).sort()).toEqual(defined);
    for (const name of defined) {
      expect(ALL_CAPABILITIES, `${name} capability`).toContain(CAPABILITY_OF[name]);
    }
  });

  it('HAPPY: grouping by capability is a partition of the inventory', () => {
    const defined = new Set(Object.keys(buildTools(makeCtx(), makeClient())));
    const grouped = new Set<string>();
    for (const cap of ALL_CAPABILITIES) {
      const tools = buildTools(makeCtx(), makeClient(), undefined, undefined, undefined, {
        capabilities: [cap],
      });
      for (const name of Object.keys(tools)) {
        expect(CAPABILITY_OF[name]).toBe(cap);
        grouped.add(name);
      }
    }
    expect([...grouped].sort()).toEqual([...defined].sort());
  });
});

describe('question-tree reachability', () => {
  it('HAPPY: every tree action and passthrough exists in buildTools', () => {
    const defined = new Set(Object.keys(buildTools(makeCtx(), makeClient())));
    for (const name of questionTreeReachableFromToolsTs()) {
      expect(defined, `${name} missing from buildTools`).toContain(name);
    }
  });

  it('HAPPY: every defined tool is either tree-reachable or explicitly parked', () => {
    const defined = Object.keys(buildTools(makeCtx(), makeClient())).sort();
    const reachable = new Set(questionTreeReachableFromToolsTs());
    const parked = new Set(Object.keys(DEFINED_UNREACHABLE_ON_QUESTION_TREE));
    const leftover = defined.filter((n) => !reachable.has(n) && !parked.has(n));
    const falselyParked = [...parked].filter((n) => reachable.has(n));
    expect(leftover, 'defined tool with no reachability verdict').toEqual([]);
    expect(falselyParked, 'parked tool that trees already offer').toEqual([]);
  });

  it('SAD: find_caller_by_name stays off the tree path (enumeration)', () => {
    expect(questionTreeReachableFromToolsTs()).not.toContain('find_caller_by_name');
    expect(DEFINED_UNREACHABLE_ON_QUESTION_TREE.find_caller_by_name).toMatch(/enumeration/i);
  });
});
