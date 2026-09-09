/**
 * ChecklistTracker — HOST CODE OWNS THE CHECKLIST. The one rung-era lesson that
 * must survive the rewrite (docs/QUESTION_TREE_ARCHITECTURE.md §2, §3.2).
 *
 * The model proposes (record_answer / set_purpose / tool calls); this class
 * disposes. It is deliberately PURE — no LiveKit, no session, no I/O — so every
 * behaviour the design conversation named is a unit test here, not a live-call
 * discovery:
 *
 *  - out-of-order volunteering ("…but we have all our people work remote")
 *  - answers recorded BEFORE their branch activates (held, promoted, or discarded)
 *  - sibling branches ruled out recursively the moment a choice is answered
 *  - mind-change ("actually it's contract-to-hire") reopening a choice and
 *    DISCARDING the dead branch's answers — no ghost data briefing the owner
 *  - declined ("I don't know the rate") as a first-class resolved state, so the
 *    model never has to fabricate a value to close a node
 *  - actions completed ONLY by their real tool's success id
 *  - a completion gate (isResolved) the goodbye can be locked on
 *
 * Errors thrown by record() are worded FOR THE MODEL — the agent returns them as
 * the tool result, so the message itself is the corrective instruction (the same
 * trick the booking standing_fact uses: the tool result is the one context the
 * model reliably re-reads).
 */
import {
  RESOLVED_STATUSES,
  type ActionNodeDef,
  type FrontierItem,
  type NodeId,
  type NodeStatus,
  type QuestionNodeDef,
  type QuestionTreeDef,
} from './types.js';

/** The library itself is malformed — a boot/test-time failure, never mid-call. */
export class TreeDefinitionError extends Error {}
/** select() was handed a tree_id the library doesn't have. */
export class UnknownTreeError extends Error {}
/** record() was handed a node_id that isn't part of this call's checklist. */
export class UnknownNodeError extends Error {}
/** record() was structurally invalid (bad option, value on an action, dead node…). */
export class RecordError extends Error {}

/** Values are caller-derived text; cap so a runaway transcription can't bloat state. */
const MAX_VALUE_LENGTH = 500;

/** One occurrence of a node in a tree: at the root, or under a choice's option. */
interface Placement {
  treeId: string;
  parent: { choiceId: NodeId; option: string } | null;
}

interface Entry {
  def: QuestionNodeDef;
  /** A node can appear in several trees AND under several branches (e.g. timezone
   *  under both remote and hybrid). It is ONE question with one value; the
   *  placements only decide when it is live. */
  placements: Placement[];
}

type Liveness = 'live' | 'latent' | 'dead' | 'unselected';

export class ChecklistTracker {
  #library = new Map<string, QuestionTreeDef>();
  #entries = new Map<NodeId, Entry>();
  /** Depth-first node order per tree — the render/frontier order. */
  #treeWalks = new Map<string, NodeId[]>();
  #selected: string[] = [];
  #values = new Map<NodeId, string>();
  #declined = new Set<NodeId>();
  #actionDone = new Map<NodeId, string>();
  /** Tenant-marked required nodes. Decline does not resolve them. */
  #required = new Set<NodeId>();
  /** Bumped on every state change (select/deselect/record/completeAction). The
   *  stall detector compares this across caller turns: a turn that moves the
   *  checklist nowhere is a stalled turn, whatever was said (bot-mirror calls,
   *  callers repeating themselves). */
  #mutations = 0;

  constructor(library: QuestionTreeDef[], opts?: { requiredNodeIds?: readonly string[] }) {
    for (const id of opts?.requiredNodeIds ?? []) {
      if (id.trim()) this.#required.add(id);
    }
    for (const tree of library) {
      if (this.#library.has(tree.tree_id)) {
        throw new TreeDefinitionError(`Duplicate tree_id "${tree.tree_id}" in library.`);
      }
      this.#library.set(tree.tree_id, tree);
      const walk: NodeId[] = [];
      this.#indexNodes(tree.nodes, tree.tree_id, null, new Set(), walk);
      this.#treeWalks.set(tree.tree_id, walk);
    }
    // requires refs are validated across the WHOLE library (they may legitimately
    // point into another tree — booking requires identity's phone), after every
    // tree is indexed. A typo'd id here would silently gate an action forever.
    for (const entry of this.#entries.values()) {
      if (entry.def.type !== 'action') continue;
      for (const req of entry.def.requires ?? []) {
        if (!this.#entries.has(req)) {
          throw new TreeDefinitionError(
            `Action "${entry.def.node_id}" requires unknown node "${req}" — not defined in any library tree.`
          );
        }
      }
    }
  }

  #indexNodes(
    nodes: QuestionNodeDef[],
    treeId: string,
    parent: Placement['parent'],
    ancestors: ReadonlySet<NodeId>,
    walk: NodeId[]
  ): void {
    for (const def of nodes) {
      // A node nested under itself would make liveness infinitely recursive.
      if (ancestors.has(def.node_id)) {
        throw new TreeDefinitionError(
          `Tree "${treeId}": node "${def.node_id}" is nested under itself.`
        );
      }
      const existing = this.#entries.get(def.node_id);
      if (existing) {
        // Shared node ids are the MERGE mechanism (caller_name exists once across
        // every tree) — but only if the definitions agree on what the node IS.
        if (existing.def.type !== def.type) {
          throw new TreeDefinitionError(
            `Node "${def.node_id}" is "${existing.def.type}" in one tree and "${def.type}" in another — shared ids must agree on type.`
          );
        }
        if (existing.def.type === 'choice' && def.type === 'choice') {
          const a = Object.keys(existing.def.options).sort().join(',');
          const b = Object.keys(def.options).sort().join(',');
          if (a !== b) {
            throw new TreeDefinitionError(
              `Choice "${def.node_id}" has options [${a}] in one tree and [${b}] in another — shared choices must offer identical options.`
            );
          }
        }
        existing.placements.push({ treeId, parent });
      } else {
        this.#entries.set(def.node_id, { def, placements: [{ treeId, parent }] });
      }
      walk.push(def.node_id);
      if (def.type === 'choice') {
        const childAncestors = new Set(ancestors).add(def.node_id);
        for (const [option, children] of Object.entries(def.options)) {
          this.#indexNodes(
            children,
            treeId,
            { choiceId: def.node_id, option },
            childAncestors,
            walk
          );
        }
      }
    }
  }

  // ── selection (the purpose accumulator) ────────────────────────────────────

  /**
   * Add trees to the live checklist. An ACCUMULATOR, callable mid-call — "oh,
   * and can I also book a time?" attaches the booking tree with everything
   * already collected still standing. Re-selecting is a harmless no-op.
   */
  select(treeIds: string[]): { added: string[] } {
    const added: string[] = [];
    for (const id of treeIds) {
      if (!this.#library.has(id)) {
        throw new UnknownTreeError(
          `No tree called "${id}". Available: ${[...this.#library.keys()].join(', ')}.`
        );
      }
      if (!this.#selected.includes(id)) {
        this.#selected.push(id);
        added.push(id);
      }
    }
    if (added.length > 0) this.#mutations++;
    return { added };
  }

  /**
   * Remove a mis-selected tree — the not_a_job lesson (2026-07-18 live call):
   * an unskippable obligation is the architecture's point, but a MISROUTED one
   * is unskippable too, and without this exit a wrongly-attached tree would
   * hold the goodbye gate shut forever. Node values are KEPT — shared nodes
   * (caller_name) belong to the call, not the tree; nodes exclusive to the
   * removed tree simply drop out of the walk and the gate.
   */
  deselect(treeId: string): void {
    if (this.#selected.includes(treeId)) this.#mutations++;
    this.#selected = this.#selected.filter((t) => t !== treeId);
  }

  /**
   * Monotonic count of state changes (selections, answers, completed actions).
   * The stall detector snapshots it per caller turn: unchanged across a turn
   * means the conversation moved the checklist nowhere.
   */
  mutationCount(): number {
    return this.#mutations;
  }

  hasSelection(): boolean {
    return this.#selected.length > 0;
  }

  selectedTrees(): string[] {
    return [...this.#selected];
  }

  // ── liveness (which branches exist right now) ──────────────────────────────

  #liveness(nodeId: NodeId, memo: Map<NodeId, Liveness> = new Map()): Liveness {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const entry = this.#entries.get(nodeId);
    const placements = entry?.placements.filter((p) => this.#selected.includes(p.treeId)) ?? [];
    let result: Liveness = 'unselected';
    // Best across placements: one live path is enough; latent beats dead (an
    // unanswered choice may yet go this way; a ruled-out one cannot).
    for (const p of placements) {
      const status = this.#placementLiveness(p, memo);
      if (status === 'live') {
        result = 'live';
        break;
      }
      if (status === 'latent') result = 'latent';
      else if (result === 'unselected') result = 'dead';
    }
    memo.set(nodeId, result);
    return result;
  }

  #placementLiveness(p: Placement, memo: Map<NodeId, Liveness>): Exclude<Liveness, 'unselected'> {
    if (!p.parent) return 'live';
    const parentLiveness = this.#liveness(p.parent.choiceId, memo);
    if (parentLiveness !== 'live') return parentLiveness === 'latent' ? 'latent' : 'dead';
    // A declined choice can never activate a branch — every branch under it is
    // ruled out, so the call can still complete.
    if (this.#declined.has(p.parent.choiceId)) return 'dead';
    const answer = this.#values.get(p.parent.choiceId);
    if (answer === undefined) return 'latent';
    return answer === p.parent.option ? 'live' : 'dead';
  }

  // ── node status ────────────────────────────────────────────────────────────

  status(nodeId: NodeId): NodeStatus {
    const entry = this.#entries.get(nodeId);
    if (!entry) return 'unselected';
    const liveness = this.#liveness(nodeId);
    if (liveness === 'unselected') return 'unselected';
    if (liveness === 'dead') return 'not_applicable';
    if (liveness === 'latent') return this.#values.has(nodeId) ? 'pending' : 'latent';
    // A listen-only node is never OPEN: unanswered, it is simply waiting to
    // overhear something, which is a resolved state for a call that can end.
    if (entry.def.type === 'text' && entry.def.listen) {
      if (this.#values.has(nodeId)) return 'answered';
      if (this.#declined.has(nodeId)) return 'declined';
      return 'latent';
    }
    if (entry.def.type === 'action') {
      if (this.#declined.has(nodeId)) return 'declined';
      if (this.#actionDone.has(nodeId)) return 'done';
      return this.unmet(nodeId).length === 0 ? 'ready' : 'blocked';
    }
    if (this.#values.has(nodeId)) return 'answered';
    if (this.#declined.has(nodeId)) return 'declined';
    return 'open';
  }

  /**
   * What still stands between an action node and 'ready'. Two gates compose:
   * explicit `requires`, and `await_tree` — every question node in the action's
   * own selected tree(s) must be resolved ("finish the intake, then write" —
   * the first mock call fired capture with half the role uncollected).
   * declined and not_applicable SATISFY both gates: on a real call the caller
   * declined three intake questions and the capture still had to land
   * (2026-07-21, call 3). The gate is ordering UX; the real tool enforces its
   * own hard needs.
   */
  unmet(nodeId: NodeId): NodeId[] {
    const entry = this.#entries.get(nodeId);
    if (!entry || entry.def.type !== 'action') return [];
    const def = entry.def;
    const out: NodeId[] = [];
    for (const req of def.requires ?? []) {
      if (!RESOLVED_STATUSES.has(this.status(req))) out.push(req);
    }
    if (def.await_tree) {
      const ownTrees = new Set(
        entry.placements.filter((p) => this.#selected.includes(p.treeId)).map((p) => p.treeId)
      );
      for (const treeId of ownTrees) {
        for (const sibling of this.#treeWalks.get(treeId) ?? []) {
          if (sibling === nodeId || out.includes(sibling)) continue;
          const siblingEntry = this.#entries.get(sibling);
          if (siblingEntry?.def.type === 'action') continue; // other actions gate themselves
          const status = this.status(sibling);
          // latent/pending are gated transitively — their parent choice is the
          // open item; naming the invisible children would only confuse.
          if (status === 'latent' || status === 'pending') continue;
          if (!RESOLVED_STATUSES.has(status)) out.push(sibling);
        }
      }
    }
    return out;
  }

  value(nodeId: NodeId): string | undefined {
    return this.#values.get(nodeId);
  }

  // ── recording (the ONLY way conversation changes state) ────────────────────

  /**
   * Record what the caller actually said for a node — an answer, or that they
   * declined. Throws RecordError/UnknownNodeError with messages written to be
   * handed straight back to the model as the tool result.
   */
  record(nodeId: NodeId, input: { value?: string; declined?: boolean }): NodeStatus {
    const entry = this.#entries.get(nodeId);
    if (!entry || this.#liveness(nodeId) === 'unselected') {
      throw new UnknownNodeError(
        `"${nodeId}" is not on this call's checklist. Record only the ids the checklist shows.`
      );
    }
    const def = entry.def;

    if (def.type === 'action') {
      if (input.declined) {
        if (this.#actionDone.has(nodeId)) {
          throw new RecordError(
            `"${nodeId}" is already DONE — its tool succeeded. It cannot be declined after the fact.`
          );
        }
        this.#declined.add(nodeId);
        this.#mutations++;
        return this.status(nodeId);
      }
      throw new RecordError(
        `"${nodeId}" is completed by calling its tool (${def.tool}), never by record_answer. ` +
          `Record it only as declined:true if the caller decides against it.`
      );
    }

    if (this.#liveness(nodeId) === 'dead') {
      const blocker = this.#blockingChoice(entry);
      throw new RecordError(
        `"${nodeId}" is not applicable on this call${
          blocker ? ` — the answer to "${blocker}" ruled it out` : ''
        }. Do not ask it.`
      );
    }

    if (input.declined) {
      if (this.#required.has(nodeId)) {
        throw new RecordError(
          `"${nodeId}" is required. declined:true does not complete it. Ask again and record what the caller actually said.`
        );
      }
      this.#values.delete(nodeId);
      this.#declined.add(nodeId);
      this.#mutations++;
      if (def.type === 'choice') this.#discardDeadAnswers();
      return this.status(nodeId);
    }

    const value = (input.value ?? '').trim().slice(0, MAX_VALUE_LENGTH);
    if (!value) {
      throw new RecordError(
        `Recording "${nodeId}" needs a value (or declined:true). Record only what the caller actually said.`
      );
    }
    if (def.type === 'choice' && !Object.hasOwn(def.options, value)) {
      // MODEL FUSES THE NODE_ID ONTO THE VALUE (2026-08-19 live call,
      // sim-call-1787158785189): asked hiring_for, the caller answered
      // plainly ("I'm hiring for my own company"), and the model recorded
      // "hiring_for_own_company" instead of "own_company" — both are
      // snake_case and sit right next to each other in the tool call, and it
      // fused them. The rejection below is correct and stays for a genuinely
      // wrong value, but a caller should never pay for this ONE shape of
      // mistake: the model re-asked "just to be clear" instead of silently
      // retrying with the key it already had, and the caller had to repeat
      // an answer that was never in doubt. Strip the node_id prefix first —
      // it can only ever match an option that a bare check would already
      // have accepted, so this never masks a genuinely invalid value.
      const prefixed = `${nodeId}_`;
      if (value.startsWith(prefixed) && Object.hasOwn(def.options, value.slice(prefixed.length))) {
        return this.record(nodeId, { value: value.slice(prefixed.length) });
      }
      // ...AND IT FUSES PARTS OF THE NODE_ID TOO (2026-09-09 live call
      // SCL_A5wnBexPbwCC). Same node, same question: asked `hiring_for`, the
      // caller said "I'm hiring for my own", and the model recorded
      // "hiring_own_company" — not `hiring_for_own_company`, so the exact-prefix
      // strip above missed it by one token. The node stayed open, the model
      // re-asked a question it already had the answer to, and the caller
      // answered "I'm hiring for my own" a SECOND time. A repair that only
      // catches one spelling of a mistake is a repair the caller still pays for.
      //
      // So: an option is accepted when the recorded value is that option plus
      // any leading run of the node_id's own words. `hiring_own_company` =
      // "hiring" (a node_id word) + `own_company`. This cannot reach an option
      // the bare check would have refused — the suffix must still BE an option
      // verbatim — and it cannot cross options, since dropping leading words
      // can only ever land on one of them.
      const nodeWords = new Set(nodeId.split('_').filter(Boolean));
      const valueWords = value.split('_');
      for (let i = 1; i < valueWords.length; i++) {
        if (!nodeWords.has(valueWords[i - 1])) break;
        const candidate = valueWords.slice(i).join('_');
        if (Object.hasOwn(def.options, candidate)) {
          return this.record(nodeId, { value: candidate });
        }
      }
      // THIS MESSAGE TAUGHT THE MODEL TO SAY "answering_service" OUT LOUD.
      //
      // 2026-08-15 sim (BUY THE SERVICE): the caller said "calls go to an
      // answering service", the model recorded "answering service", this
      // refusal listed the raw tokens — and its very next spoken sentence was
      // "Just to be sure, would you say your calls go to an answering_service?"
      // Underscore and all. That is precisely the 2026-07-21 live-call defect
      // the prompt has forbidden ever since ("record them exactly, but NEVER
      // speak them"), reproduced here by the host handing the model a list of
      // internal tokens at the exact moment it was composing a question.
      //
      // The tokens still have to appear — they are what must be recorded — so
      // the fix is to say plainly, in the same breath, that they are not words
      // for a caller, and to show the spoken form next to each one.
      const spoken = Object.keys(def.options)
        .map((key) => `${key} (say "${key.replace(/_/g, ' ')}")`)
        .join(', ');
      throw new RecordError(
        `"${value}" is not an option for "${nodeId}". The options are exactly: ${spoken}. ` +
          `Those ids are INTERNAL — record one of them verbatim, but NEVER say one to the ` +
          `caller: ask in ordinary words and map their answer yourself.`
      );
    }

    this.#values.set(nodeId, value);
    this.#declined.delete(nodeId);
    this.#mutations++;
    // Answering (or re-answering — the mind-change) a choice redraws the map:
    // branches just ruled out take their recorded answers with them. Kept data
    // under a dead branch is a ghost that would brief the owner on a hypothesis
    // the caller withdrew.
    if (def.type === 'choice') this.#discardDeadAnswers();
    return this.status(nodeId);
  }

  #blockingChoice(entry: Entry): NodeId | null {
    for (const p of entry.placements) {
      if (!p.parent || !this.#selected.includes(p.treeId)) continue;
      const answer = this.#values.get(p.parent.choiceId);
      if (answer !== undefined && answer !== p.parent.option) return p.parent.choiceId;
      if (this.#declined.has(p.parent.choiceId)) return p.parent.choiceId;
    }
    return null;
  }

  #discardDeadAnswers(): void {
    const memo = new Map<NodeId, Liveness>();
    for (const nodeId of this.#entries.keys()) {
      if (this.#liveness(nodeId, memo) === 'dead') {
        this.#values.delete(nodeId);
        this.#declined.delete(nodeId);
        // #actionDone is deliberately KEPT — a landed backend write is history,
        // not state to un-know.
      }
    }
  }

  /**
   * The HOST marks an action done when its real tool returned a success id —
   * the agent calls this from the tool wrapper, exactly where the rung ACTION
   * completion lived. The model has no path to it.
   */
  completeAction(nodeId: NodeId, successId: string): void {
    const entry = this.#entries.get(nodeId);
    if (!entry || entry.def.type !== 'action') {
      throw new UnknownNodeError(`"${nodeId}" is not an action node.`);
    }
    this.#actionDone.set(nodeId, successId);
    this.#declined.delete(nodeId);
    this.#mutations++;
  }

  // ── what the model sees, and the gate ──────────────────────────────────────

  /** Live, open ask nodes + ready actions — what may be asked or done RIGHT NOW. */
  frontier(): FrontierItem[] {
    const items: FrontierItem[] = [];
    for (const nodeId of this.#selectedWalk()) {
      const entry = this.#entries.get(nodeId)!;
      const status = this.status(nodeId);
      if (status === 'open') {
        items.push({
          node_id: nodeId,
          kind: 'ask',
          detail: (entry.def as { ask: string }).ask,
        });
      } else if (status === 'ready') {
        const def = entry.def as ActionNodeDef;
        items.push({ node_id: nodeId, kind: 'action', detail: `${def.description} (${def.tool})` });
      }
    }
    return items;
  }

  /**
   * Every selected node once — identity first, BOOKING second, everything else
   * in selection order after.
   *
   * The walk order IS the ask order: the model works the rendered checklist
   * top-down. It used to be pure selection order, so `[identity, job, booking]`
   * queued the entire role intake ahead of the meeting — and on the 2026-07-21
   * live call the caller had to protest "you never let me set up a meeting, you
   * just blew right past that" after answering six intake questions. The
   * product's oldest lesson is BOOK FIRST: the meeting is what they rang for;
   * every other question is preparation for it, and preparation comes after
   * the thing it prepares. Host-enforced here so no selection order the model
   * chooses can put an intake ahead of the diary. (Bonus: capture actions that
   * link to the appointment — job_inquiries.appointment_id — only link when
   * the booking lands first.)
   */
  #selectedWalk(): NodeId[] {
    const priority = (treeId: string): number =>
      treeId === 'identity' ? 0 : treeId === 'booking' ? 1 : 2;
    const ordered = [...this.#selected].sort((a, b) => priority(a) - priority(b));
    const seen = new Set<NodeId>();
    const out: NodeId[] = [];
    for (const treeId of ordered) {
      for (const nodeId of this.#treeWalks.get(treeId) ?? []) {
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          out.push(nodeId);
        }
      }
    }
    return out;
  }

  /**
   * The compact checklist the model reads every time it records — designed to be
   * a TOOL RESULT (the context the model actually re-reads all call, the
   * standing_fact lesson). Dead branches are OMITTED entirely: a question not in
   * the prompt cannot be asked. Latent branches are shown listen-only, so
   * volunteered answers ahead of a choice still get captured.
   */
  renderState(): string {
    const lines: string[] = [];
    for (const nodeId of this.#selectedWalk()) {
      const entry = this.#entries.get(nodeId)!;
      const def = entry.def;
      switch (this.status(nodeId)) {
        case 'answered':
          lines.push(`[✓] ${nodeId}: ${this.#values.get(nodeId)}`);
          break;
        case 'open':
          lines.push(`[ASK] ${nodeId} — ${(def as { ask: string }).ask}`);
          break;
        case 'declined':
          lines.push(
            this.#required.has(nodeId)
              ? `[ASK] ${nodeId} — ${(def as { ask: string }).ask} (required — a decline does not count)`
              : `[—] ${nodeId}: caller declined / could not say (resolved — do not re-ask)`
          );
          break;
        case 'latent':
          lines.push(
            def.type === 'text' && def.listen
              ? // Listen-ONLY: no trigger to name and nothing to wait for — it is
                // never asked at all, in any branch, on any call.
                `[listen] ${nodeId} — ${def.ask} (NEVER ask this; record it only if the caller volunteers it)`
              : `[listen] ${nodeId} — ${(def as { ask: string }).ask} (${this.#latentTrigger(entry)}; do NOT ask yet — record it if the caller volunteers it)`
          );
          break;
        case 'pending':
          lines.push(
            `[held] ${nodeId}: ${this.#values.get(nodeId)} (recorded early — ${this.#latentTrigger(entry)})`
          );
          break;
        case 'ready':
          lines.push(
            `[ACTION NOW] ${nodeId} — ${(def as ActionNodeDef).description}: call ${(def as ActionNodeDef).tool}`
          );
          break;
        case 'blocked': {
          const unmet = this.unmet(nodeId);
          lines.push(
            `[action later] ${nodeId} — ${(def as ActionNodeDef).description} (first: ${unmet.join(', ')})`
          );
          break;
        }
        case 'done':
          lines.push(`[✓] ${nodeId} — done (${(def as ActionNodeDef).tool} succeeded)`);
          break;
        case 'not_applicable':
        case 'unselected':
          break; // omitted: not in the prompt = cannot be asked
      }
    }
    const header =
      'CHECKLIST — fill anything you hear with record_answer; ask ONLY items marked [ASK]. ' +
      'Record only what the caller actually said — never stretch an inference into a field.';
    const footer = this.isResolved() ? 'CHECKLIST COMPLETE — nothing left to collect.' : undefined;
    return [header, ...lines, ...(footer ? [footer] : [])].join('\n');
  }

  #latentTrigger(entry: Entry): string {
    const triggers = entry.placements
      .filter((p) => this.#selected.includes(p.treeId) && p.parent)
      .map((p) => `only if ${p.parent!.choiceId} = ${p.parent!.option}`);
    return [...new Set(triggers)].join(' or ') || 'awaiting an earlier answer';
  }

  /**
   * THE GOODBYE GATE. True only when a purpose has been selected and every
   * selected node is resolved. finish_call refuses to close while this is false —
   * the structural guarantee that no stated goal is forgotten, which is what
   * book-first actually existed to protect.
   */
  isResolved(): boolean {
    if (!this.hasSelection()) return false;
    return this.unresolvedNodeIds().length === 0;
  }

  /**
   * The nodes `isResolved()` is currently waiting on — the gate's own reason,
   * in a form a log can carry. Exists so a released or stuck goodbye can be
   * diagnosed from prod logs without reconstructing the walk by hand.
   */
  unresolvedNodeIds(): NodeId[] {
    if (!this.hasSelection()) return [];
    return this.#selectedWalk().filter((nodeId) => !this.#isNodeResolved(nodeId));
  }

  #isNodeResolved(nodeId: NodeId): boolean {
    const status = this.status(nodeId);
    // Required nodes stay open until answered. Decline is recorded only when
    // the field is not required — record() refuses declined:true here, and
    // this check is the backstop if state is ever forced.
    if (this.#required.has(nodeId) && status !== 'answered' && status !== 'not_applicable') {
      const def = this.#entries.get(nodeId)?.def;
      if (status === 'latent' && def?.type === 'text' && def.listen === true) {
        return true;
      }
      if (status === 'done' || status === 'unselected') return true;
      return false;
    }
    if (RESOLVED_STATUSES.has(status)) return true;
    // A LISTEN-ONLY node never holds the door shut. It was never asked, so a
    // caller cannot answer it, so waiting on it would mean waiting forever —
    // exactly the shape of the wrong-tree deadlock that stranded a caller on
    // dead air (2026-07-22). Latent-under-a-choice nodes still gate normally:
    // their parent choice is the real open question.
    const def = this.#entries.get(nodeId)?.def;
    return status === 'latent' && def?.type === 'text' && def.listen === true;
  }

  /** Full node → state view, for tests, logs, and the eventual dashboard view. */
  snapshot(): Record<NodeId, { status: NodeStatus; value?: string }> {
    const out: Record<NodeId, { status: NodeStatus; value?: string }> = {};
    for (const nodeId of this.#selectedWalk()) {
      const status = this.status(nodeId);
      const value = this.#values.get(nodeId) ?? this.#actionDone.get(nodeId);
      out[nodeId] = value !== undefined ? { status, value } : { status };
    }
    return out;
  }
}
