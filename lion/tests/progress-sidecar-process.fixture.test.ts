import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import type { LionProgressSnapshot } from "../extension/schema.ts";

const enabled = process.env.LION_PROGRESS_CHILD === "1";

describe.skipIf(!enabled)("progress sidecar child process fixture", () => {
	it("flushes several exact-incarnation snapshots", async () => {
		const runsPath = process.env.LION_RUNS_PATH!;
		const runId = process.env.LION_RUN_ID!;
		const incarnationId = process.env.LION_INCARNATION_ID!;
		const activityPrefix = process.env.LION_ACTIVITY_PREFIX!;
		assert.ok(runsPath && runId && incarnationId && activityPrefix);
		const store = new LionStore(new FileBackend({ runsPath, dir: path.dirname(runsPath) }));
		for (let turn = 1; turn <= 3; turn++) {
			const progress: LionProgressSnapshot = {
				event: "message",
				activity: `${activityPrefix}:${turn}`,
				active_tools: [],
				tool_uses: turn,
				turn_count: turn,
				token_total: turn * 10,
				last_text: null,
				last_event_at: new Date(Date.now() + turn).toISOString(),
			};
			assert.ok(await store.flushProgress({ id: runId, incarnation_id: incarnationId }, progress));
		}
	});
});
