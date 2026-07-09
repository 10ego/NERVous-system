import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import { AdaptivePoller, createLionRpcRunner, type LionRpcClient } from "../extension/rpc-runner.ts";

class FakeRpcClient implements LionRpcClient {
	started = false;
	stopped = false;
	prompted: string | null = null;
	steered: string[] = [];
	throwOnSteer = false;
	throwOnPrompt = false;
	private idleResolve: (() => void) | null = null;
	private listeners: Array<(event: unknown) => void> = [];

	async start() { this.started = true; }
	async stop() { this.stopped = true; }
	async prompt(message: string) {
		if (this.throwOnPrompt) throw new Error("prompt boom");
		this.prompted = message;
		this.emit({ type: "message_update", delta: "working" });
	}
	async steer(message: string) {
		if (this.throwOnSteer) throw new Error("steer boom");
		this.steered.push(message);
		this.idleResolve?.();
		this.emit({ type: "agent_end", messages: [], willRetry: false });
	}
	async abort() { this.idleResolve?.(); }
	waitForIdle() {
		return new Promise<void>((resolve) => { this.idleResolve = resolve; });
	}
	async getLastAssistantText() {
		return JSON.stringify({ WORKER_REPORT: { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] } });
	}
	onEvent(listener: (event: unknown) => void) {
		this.listeners.push(listener);
		return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
	}
	getProcessInfo() { return { pid: process.pid, pgid: null }; }
	emit(event: unknown) { for (const listener of this.listeners) listener(event); }
	finish() { this.idleResolve?.(); this.emit({ type: "agent_end", messages: [], willRetry: false }); }
}

async function makeStore() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-rpc-runner-"));
	return new LionStore(new FileBackend({ runsPath: path.join(dir, "runs.json"), dir }));
}

async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 1000) {
	const start = Date.now();
	while (!(await fn())) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(() => vi.useRealTimers());

describe("AdaptivePoller", () => {
	it("backs off while idle, resets after work, and never overlaps", async () => {
		vi.useFakeTimers();
		const work = [false, false, true, false];
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const poller = new AdaptivePoller(async () => {
			calls++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inFlight--;
			return work.shift() ?? false;
		}, 100, 400);
		poller.start();

		await vi.advanceTimersByTimeAsync(100); // first starts
		await vi.advanceTimersByTimeAsync(10); // first completes; next in 200
		await vi.advanceTimersByTimeAsync(199);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(1); // second starts
		await vi.advanceTimersByTimeAsync(10); // second completes; next in 400
		await vi.advanceTimersByTimeAsync(400); // third starts
		await vi.advanceTimersByTimeAsync(10); // work resets next delay to 100
		await vi.advanceTimersByTimeAsync(100); // fourth starts
		await vi.advanceTimersByTimeAsync(10);
		assert.equal(calls, 4);
		assert.equal(maxInFlight, 1);
		poller.stop();
		await vi.advanceTimersByTimeAsync(1000);
		assert.equal(calls, 4);
	});
});

describe("createLionRpcRunner", () => {
	it("delivers pending live steering through RpcClient.steer exactly once", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "do rpc work", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000 });
		await until(() => fake.prompted !== null);
		await store.mutate((l) => l.steer(run.id, "Please adjust course", { liveDeliveryAvailable: true }));
		const out = await promise;
		assert.equal(out.report?.outcome, "completed");
		assert.deepEqual(fake.steered, ["Please adjust course"]);
		const final = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(final.steering_messages?.[0]?.status, "delivered");
		assert.equal(fake.stopped, true);
	});

	it("calls process-exit callbacks only once on RPC errors", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.throwOnPrompt = true;
		const run = (await store.mutate((l) => l.create({ objective: "do rpc work", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		let exits = 0;
		await assert.rejects(() => runner({ run, timeout_ms: 1000, onProcessExit: () => { exits++; } }), /prompt boom/);
		assert.equal(exits, 1);
	});

	it("fails steering that arrives after RPC idle closes", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "do rpc work", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({
			cwd: process.cwd(),
			store,
			pollIntervalMs: 5,
			clientFactory: () => fake,
			onSteeringClosed: async () => {
				await store.mutate((l) => l.steer(run.id, "Too late", { liveDeliveryAvailable: true }));
			},
		});
		const promise = runner({ run, timeout_ms: 1000 });
		await until(() => fake.prompted !== null);
		fake.finish();
		await promise;
		assert.deepEqual(fake.steered, []);
		const final = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(final.steering_messages?.[0]?.status, "delivery_failed");
		assert.match(final.steering_messages?.[0]?.reason ?? "", /run finished/);
	});

	it("marks live steering delivery failures durably", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.throwOnSteer = true;
		const run = (await store.mutate((l) => l.create({ objective: "do rpc work", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000 });
		await until(() => fake.prompted !== null);
		await store.mutate((l) => l.steer(run.id, "This will fail", { liveDeliveryAvailable: true }));
		await until(async () => {
			const current = (await store.query((l) => l.get(run.id))).result;
			return current?.steering_messages?.[0]?.status === "delivery_failed";
		});
		fake.finish();
		await promise;
		const final = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(final.steering_messages?.[0]?.status, "delivery_failed");
		assert.match(final.steering_messages?.[0]?.reason ?? "", /steer boom/);
	});
});
