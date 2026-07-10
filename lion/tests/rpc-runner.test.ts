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
	alive = true;
	stopCalls = 0;
	abortCalls = 0;
	waitForIdleCalls = 0;
	prompted: string | null = null;
	steered: string[] = [];
	throwOnSteer = false;
	throwOnPrompt = false;
	hangOnPrompt = false;
	startGate: Promise<void> | null = null;
	throwOnAbort = false;
	throwOnStop = false;
	hangOnStop = false;
	stopDelayMs = 0;
	hangOnAbort = false;
	killOnSignal = false;
	finishDuringPrompt = false;
	lastTextGate: Promise<void> | null = null;
	private idleResolve: (() => void) | null = null;
	private exitResolve: (() => void) | null = null;
	private listeners: Array<(event: unknown) => void> = [];

	async start() { this.started = true; if (this.startGate) await this.startGate; }
	async stop() {
		this.stopCalls++;
		if (this.throwOnStop) throw new Error("stop boom");
		if (this.hangOnStop) return new Promise<void>(() => undefined);
		if (this.stopDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stopDelayMs));
		this.stopped = true;
		this.idleResolve?.();
		this.exit();
	}
	async prompt(message: string) {
		if (this.throwOnPrompt) throw new Error("prompt boom");
		if (this.hangOnPrompt) return new Promise<void>(() => undefined);
		this.prompted = message;
		this.emit({ type: "message_update", delta: "working" });
		if (this.finishDuringPrompt) this.finish();
	}
	async steer(message: string) {
		if (this.throwOnSteer) throw new Error("steer boom");
		this.steered.push(message);
		this.idleResolve?.();
		this.emit({ type: "agent_end", messages: [], willRetry: false });
	}
	async abort() {
		this.abortCalls++;
		if (this.throwOnAbort) throw new Error("abort boom");
		if (this.hangOnAbort) return new Promise<void>(() => undefined);
		this.idleResolve?.();
	}
	waitForIdle() {
		this.waitForIdleCalls++;
		return new Promise<void>((resolve) => { this.idleResolve = resolve; });
	}
	async getLastAssistantText() {
		if (this.lastTextGate) await this.lastTextGate;
		return JSON.stringify({ WORKER_REPORT: { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] } });
	}
	onEvent(listener: (event: unknown) => void) {
		this.listeners.push(listener);
		return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
	}
	getProcessInfo() {
		return {
			pid: process.pid,
			pgid: null,
			isAlive: () => this.alive,
			cancel: (signal = "SIGTERM") => {
				if (!this.killOnSignal || signal !== "SIGKILL") return false;
				this.exit();
				return true;
			},
		};
	}
	waitForExit() { return new Promise<void>((resolve) => { this.exitResolve = resolve; }); }
	emit(event: unknown) { for (const listener of this.listeners) listener(event); }
	finish() { this.idleResolve?.(); this.emit({ type: "agent_end", messages: [], willRetry: false }); }
	exit() { if (!this.alive) return; this.alive = false; this.exitResolve?.(); }
	listenerCount() { return this.listeners.length; }
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

	it("persists a reserved RPC steering batch with one acknowledgement mutation", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "batch steering", runner_mode: "rpc" }))).result;
		for (const message of ["one", "two", "three"]) await store.mutate((l) => l.steer(run.id, message, { liveDeliveryAvailable: true }));
		fake.steer = async (message: string) => {
			fake.steered.push(message);
			if (fake.steered.length === 3) fake.finish();
		};
		const originalMutate = store.mutate.bind(store);
		let writes = 0;
		(store as any).mutate = async (fn: unknown) => { writes++; return originalMutate(fn as never); };
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		await runner({ run, timeout_ms: 1000 });
		assert.deepEqual(fake.steered, ["one", "two", "three"]);
		assert.equal(writes, 3, "one reservation, one batched acknowledgement, and one channel-closure write");
		const final = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(final.steering_messages?.every((message) => message.status === "delivered"), true);
	});

	it("rejects a pre-aborted run before client creation or prompt", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "cancelled rpc", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		controller.abort();
		let factoryCalls = 0;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => { factoryCalls++; return fake; } });
		await assert.rejects(() => runner({ run, signal: controller.signal, timeout_ms: 1000 }), /aborted before prompt/);
		assert.equal(factoryCalls, 0);
		assert.equal(fake.prompted, null);
		assert.equal(fake.waitForIdleCalls, 0);
	});

	it("does not prompt when cancellation arrives during client start", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		let releaseStart!: () => void;
		fake.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
		const run = (await store.mutate((l) => l.create({ objective: "abort during start", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000 });
		await until(() => fake.started);
		controller.abort();
		releaseStart();
		await assert.rejects(() => promise, /aborted/);
		assert.equal(fake.prompted, null);
		assert.ok(fake.stopCalls >= 1);
	});

	it("adopts a child spawned by an interrupted start and retains ownership until exit", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.startGate = new Promise<void>(() => undefined);
		fake.throwOnStop = true;
		const run = (await store.mutate((l) => l.create({ objective: "spawn then hang", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		let starts = 0;
		let exits = 0;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000, onProcessStart: () => { starts++; }, onProcessExit: () => { exits++; } });
		await until(() => fake.started && starts === 1);
		controller.abort();
		await until(() => fake.stopCalls === 1);
		let settled = false;
		void promise.then(() => { settled = true; }, () => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false);
		assert.equal(fake.alive, true);
		assert.equal(exits, 0);
		fake.exit();
		await assert.rejects(() => promise, /stop boom/);
		assert.equal(exits, 1);
	});

	it("bounds a prompt that never acknowledges by the session timeout", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.hangOnPrompt = true;
		const run = (await store.mutate((l) => l.create({ objective: "hung prompt", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		await assert.rejects(() => runner({ run, timeout_ms: 1000 }), /timed out after 1000ms/);
		assert.equal(fake.stopCalls, 1);
		assert.equal(fake.listenerCount(), 0);
	});

	it("applies the session deadline while client setup is pending and stops a late client", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "hung factory", runner_mode: "rpc" }))).result;
		let releaseFactory!: () => void;
		const factoryGate = new Promise<void>((resolve) => { releaseFactory = resolve; });
		const runner = createLionRpcRunner({
			cwd: process.cwd(),
			store,
			clientFactory: async () => { await factoryGate; return fake; },
		});
		await assert.rejects(() => runner({ run, timeout_ms: 20 }), /timed out after 20ms/);
		releaseFactory();
		await until(() => fake.stopCalls === 1);
		assert.equal(fake.started, false);
	});

	it("stops a synchronously returned client when its factory aborts setup", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "factory abort", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		const runner = createLionRpcRunner({
			cwd: process.cwd(),
			store,
			clientFactory: () => { controller.abort(); return fake; },
		});
		await assert.rejects(() => runner({ run, signal: controller.signal, timeout_ms: 1000 }), /aborted/);
		await until(() => fake.stopCalls === 1);
		assert.equal(fake.started, false);
	});

	it("applies abort supervision while prompt persistence is pending and cleans its directory", async () => {
		const store = await makeStore();
		const run = (await store.mutate((l) => l.create({ objective: "hung prompt persistence", runner_mode: "rpc" }))).result;
		const before = new Set((await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("pi-lion-rpc-")));
		let writerStarted!: () => void;
		let releaseWriter!: () => void;
		const entered = new Promise<void>((resolve) => { writerStarted = resolve; });
		const gate = new Promise<void>((resolve) => { releaseWriter = resolve; });
		const controller = new AbortController();
		const runner = createLionRpcRunner({
			cwd: process.cwd(),
			store,
			writePromptFile: async () => { writerStarted(); await gate; },
			clientFactory: () => new FakeRpcClient(),
		});
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000 });
		await entered;
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
		const leaked = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("pi-lion-rpc-") && !before.has(entry));
		assert.deepEqual(leaked, []);
		releaseWriter();
	});

	it("observes RPC idle emitted during prompt acknowledgement", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.finishDuringPrompt = true;
		const run = (await store.mutate((l) => l.create({ objective: "immediate idle", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const output = await runner({ run, timeout_ms: 1000 });
		assert.equal(output.report?.outcome, "completed");
		assert.equal(fake.waitForIdleCalls, 0);
	});

	it("keeps abort supervision active through final assistant-text I/O", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "hung final text", runner_mode: "rpc" }))).result;
		let finalTextStarted!: () => void;
		let releaseFinalText!: () => void;
		const entered = new Promise<void>((resolve) => { finalTextStarted = resolve; });
		const gate = new Promise<void>((resolve) => { releaseFinalText = resolve; });
		fake.getLastAssistantText = async () => { finalTextStarted(); await gate; return "done"; };
		const controller = new AbortController();
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000 });
		await until(() => fake.prompted !== null);
		fake.finish();
		await entered;
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
		releaseFinalText();
	});

	it("keeps deadline supervision active through final assistant-text I/O", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.lastTextGate = new Promise<void>(() => undefined);
		const run = (await store.mutate((l) => l.create({ objective: "timed final text", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 30 });
		await until(() => fake.prompted !== null);
		fake.finish();
		await assert.rejects(() => promise, /timed out after 30ms/);
	});

	it("bounds a pending stop during final-I/O cancellation and hard-stops the owned child", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.lastTextGate = new Promise<void>(() => undefined);
		fake.hangOnStop = true;
		fake.killOnSignal = true;
		const run = (await store.mutate((l) => l.create({ objective: "hung final stop", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, abortGraceMs: 5, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 30 });
		await until(() => fake.prompted !== null);
		fake.finish();
		await assert.rejects(() => promise, /RPC stop timed out/);
		assert.equal(fake.alive, false);
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
		assert.equal(fake.waitForIdleCalls, 0);
		assert.equal(fake.listenerCount(), 0);
		assert.equal(fake.stopCalls, 1);
	});

	it("allows the default RpcClient stop grace to finish before the wrapper times out", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.stopDelayMs = 1100;
		const run = (await store.mutate((l) => l.create({ objective: "graceful delayed stop", runner_mode: "rpc" }))).result;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 5000 });
		await until(() => fake.prompted !== null);
		fake.finish();
		const output = await promise;
		assert.equal(output.report?.outcome, "completed");
		assert.equal(fake.stopCalls, 1);
	});

	it("does not report process exit when interrupted start exposed no child and stop succeeds", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.startGate = new Promise<void>(() => undefined);
		fake.getProcessInfo = () => null as never;
		const run = (await store.mutate((l) => l.create({ objective: "no spawned child", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		let exits = 0;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000, onProcessExit: () => { exits++; } });
		await until(() => fake.started);
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
		assert.equal(exits, 0);
	});

	it("bounds interrupted start cleanup when no process handle is ever exposed", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.startGate = new Promise<void>(() => undefined);
		fake.hangOnStop = true;
		fake.getProcessInfo = () => null as never;
		const run = (await store.mutate((l) => l.create({ objective: "unobservable interrupted start", runner_mode: "rpc" }))).result;
		const controller = new AbortController();
		let exits = 0;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, abortGraceMs: 5, stopGraceMs: 5, startObservationGraceMs: 20, clientFactory: () => fake });
		const startedAt = Date.now();
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000, onProcessExit: () => { exits++; } });
		await until(() => fake.started);
		controller.abort();
		await assert.rejects(() => promise, /RPC stop timed out/);
		assert.ok(Date.now() - startedAt < 500, "cleanup fallback should be bounded");
		assert.equal(exits, 0, "an unobserved child must not be reported exited");
	});

	it("propagates normal stop failure without reporting a live child exited", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.throwOnStop = true;
		const run = (await store.mutate((l) => l.create({ objective: "stop failure", runner_mode: "rpc" }))).result;
		let exits = 0;
		let processInfo: import("../extension/subprocess.ts").LionProcessInfo | undefined;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000, onProcessStart: (info) => { processInfo = info; }, onProcessExit: () => { exits++; } });
		await until(() => fake.prompted !== null);
		fake.finish();
		let settled = false;
		void promise.then(() => { settled = true; }, () => { settled = true; });
		await until(() => fake.stopCalls === 1);
		assert.equal(settled, false);
		assert.equal(processInfo?.isAlive?.(), true);
		assert.equal(exits, 0);
		fake.exit();
		await assert.rejects(() => promise, /stop boom/);
		assert.equal(exits, 1);
	});

	it("rechecks the channel after a delayed pending query before steering", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "race idle", runner_mode: "rpc" }))).result;
		await store.mutate((l) => l.steer(run.id, "must not cross idle", { liveDeliveryAvailable: true }));
		const originalQuery = store.query.bind(store);
		let releaseQuery!: () => void;
		let queryStarted!: () => void;
		const queryEntered = new Promise<void>((resolve) => { queryStarted = resolve; });
		const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
		let delayed = false;
		(store as unknown as { query: LionStore["query"] }).query = async (fn) => {
			if (!delayed) { delayed = true; queryStarted(); await queryGate; }
			return originalQuery(fn);
		};
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000 });
		await queryEntered;
		fake.finish();
		releaseQuery();
		await promise;
		assert.deepEqual(fake.steered, []);
		const final = (await originalQuery((l) => l.get(run.id))).result!;
		assert.equal(final.steering_messages?.[0]?.status, "delivery_failed");
	});

	it("does not wait for blocked initial steering I/O after cancellation", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "cancel blocked delivery", runner_mode: "rpc" }))).result;
		await store.mutate((l) => l.steer(run.id, "pending", { liveDeliveryAvailable: true }));
		const originalQuery = store.query.bind(store);
		let releaseQuery!: () => void;
		let queryStarted!: () => void;
		const queryEntered = new Promise<void>((resolve) => { queryStarted = resolve; });
		const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
		let delayed = false;
		(store as unknown as { query: LionStore["query"] }).query = async (fn) => {
			if (!delayed) { delayed = true; queryStarted(); await queryGate; }
			return originalQuery(fn);
		};
		const controller = new AbortController();
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, signal: controller.signal, timeout_ms: 1000 });
		await queryEntered;
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
		releaseQuery();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(fake.steered, []);
	});

	it("does not let an abandoned steering acknowledgement mutate a replacement incarnation", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const original = (await store.mutate((l) => l.create({ objective: "old rpc", runner_mode: "rpc" }))).result;
		await store.mutate((l) => l.steer(original.id, "old steering", { liveDeliveryAvailable: true }));
		let releaseSteer!: () => void;
		let enteredSteer!: () => void;
		const steerEntered = new Promise<void>((resolve) => { enteredSteer = resolve; });
		const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
		fake.steer = async () => { enteredSteer(); await steerGate; };
		const controller = new AbortController();
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, pollIntervalMs: 5, clientFactory: () => fake });
		const running = runner({ run: original, signal: controller.signal, timeout_ms: 1000 });
		await steerEntered;
		controller.abort();
		await assert.rejects(() => running, /aborted/);
		await store.mutate((l) => {
			l.finish(original.id, { output: "", report: null, status: "aborted", error: "cancelled" });
			l.delete(original.id);
		});
		const replacement = (await store.mutate((l) => l.create({ objective: "new rpc", runner_mode: "rpc" }))).result;
		await store.mutate((l) => l.steer(replacement.id, "new steering", { liveDeliveryAvailable: true }));
		releaseSteer();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const current = (await store.query((l) => l.get(replacement.id))).result!;
		assert.notEqual(replacement.incarnation_id, original.incarnation_id);
		assert.equal(current.steering_messages?.[0]?.status, "pending_delivery");
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

	it("reports actual child exit through the attached process handle", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		const run = (await store.mutate((l) => l.create({ objective: "observe exit", runner_mode: "rpc" }))).result;
		let processInfo: import("../extension/subprocess.ts").LionProcessInfo | undefined;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000, onProcessStart: (info) => { processInfo = info; } });
		await until(() => fake.prompted !== null);
		assert.equal(processInfo?.isAlive?.(), true);
		fake.exit();
		assert.equal(processInfo?.isAlive?.(), false);
		await assert.rejects(() => promise, /child exited before becoming idle/);
	});

	it("attempts stop and preserves the graceful abort error", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.throwOnAbort = true;
		const run = (await store.mutate((l) => l.create({ objective: "abort error", runner_mode: "rpc" }))).result;
		let processInfo: import("../extension/subprocess.ts").LionProcessInfo | undefined;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000, onProcessStart: (info) => { processInfo = info; } });
		await until(() => fake.prompted !== null);
		await assert.rejects(() => Promise.resolve(processInfo!.cancel!()), /abort boom/);
		assert.equal(fake.stopCalls, 1);
		assert.equal(fake.alive, false);
		await assert.rejects(() => promise, /abort boom/);
	});

	it("stops the child after a graceful abort timeout", async () => {
		const store = await makeStore();
		const fake = new FakeRpcClient();
		fake.hangOnAbort = true;
		const run = (await store.mutate((l) => l.create({ objective: "abort timeout", runner_mode: "rpc" }))).result;
		let processInfo: import("../extension/subprocess.ts").LionProcessInfo | undefined;
		const runner = createLionRpcRunner({ cwd: process.cwd(), store, abortGraceMs: 5, clientFactory: () => fake });
		const promise = runner({ run, timeout_ms: 1000, onProcessStart: (info) => { processInfo = info; } });
		await until(() => fake.prompted !== null);
		await assert.rejects(() => Promise.resolve(processInfo!.cancel!()), /abort timed out/);
		assert.equal(fake.stopCalls, 1);
		assert.equal(fake.alive, false);
		await assert.rejects(() => promise, /abort timed out/);
	});

	it("removes the RPC temporary directory when prompt writing fails", async () => {
		const store = await makeStore();
		const run = (await store.mutate((l) => l.create({ objective: "prompt write failure", runner_mode: "rpc" }))).result;
		const before = new Set((await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("pi-lion-rpc-")));
		const runner = createLionRpcRunner({
			cwd: process.cwd(),
			store,
			clientFactory: () => new FakeRpcClient(),
			writePromptFile: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
		});
		await assert.rejects(() => runner({ run, timeout_ms: 1000 }), /disk full/);
		const after = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("pi-lion-rpc-") && !before.has(entry));
		assert.deepEqual(after, []);
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
