/** Types for scripts/verify-e2e-shards.mjs (kept separate so the .mjs runs with plain `node` in CI). */
export interface CollectedTest {
  project: string;
  id: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  total: number;
  perShard: number[];
}

export function collectTests(report: object): CollectedTest[];

export function verifyShards(input: {
  fulls: object[];
  shards: object[];
  expectedShards: number;
}): VerifyResult;
