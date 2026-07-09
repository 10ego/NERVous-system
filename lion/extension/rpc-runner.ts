/**
 * LION — RPC-backed runner.
 *
 * This runner is an explicit opt-in alternative to the legacy json subprocess
 * runner. It uses pi's official RPC mode so a running worker can receive real
 * mid-run steering through RpcClient.steer().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { LionStore } from "./backend.ts";
import type { LionProgressSnapshot, LionReport } from "./schema.ts";
import { buildLionSystemPrompt, buildLionUserPrompt, createLionProgressState, parseLionReport, progressFromEvent, type LionProcessInfo, type LionRunOutput, type LionRunRequest } from "./subprocess.ts";

export interface LionRpcClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(timeout?: number): Promise<void>;
	getLastAssistantText(): Promise<string | null>;
	onEvent(listener: (event: unknown) => void): () => void;
	getStderr?(): string;
	getProcessInfo?(): LionProcessInfo | null;
}

export interface LionRpcClientConfig {
	cwd: string;
	model?: string | null;
	tools?: string[] | null;
	systemPromptPath: string;
	extraArgs?: string[];
}

export interface LionRpcRunnerOptions {
	cwd: string;
	store: LionStore;
	extraArgs?: string[];
	/** Initial adaptive pending-steering poll delay. */
	pollIntervalMs?: number;
	/** Maximum adaptive pending-steering poll delay. */
	maxPollIntervalMs?: number;
	clientFactory?: (config: LionRpcClientConfig) => Promise<LionRpcClient> | LionRpcClient;
	/** Test/diagnostic hook invoked after the steering channel closes at idle. */
	onSteeringClosed?: () => Promise<void> | void;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2000;

export class AdaptivePoller {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private stopped = true;
	private nextDelay: number;

	constructor(
		private readonly task: () => Promise<boolean>,
		private readonly minDelayMs = DEFAULT_POLL_INTERVAL_MS,
		private readonly maxDelayMs = DEFAULT_MAX_POLL_INTERVAL_MS,
	) {
		this.nextDelay = minDelayMs;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(this.minDelayMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	wake(): void {
		this.nextDelay = this.minDelayMs;
		if (this.stopped || this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.schedule(0);
	}

	private schedule(delay: number): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, Math.max(0, delay));
		this.timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.running) return;
		this.running = true;
		let hadWork = false;
		try { hadWork = await this.task(); }
		catch { /* polling is best-effort; retry with backoff */ }
		finally { this.running = false; }
		if (this.stopped) return;
		this.nextDelay = hadWork ? this.minDelayMs : Math.min(this.maxDelayMs, Math.max(this.minDelayMs, this.nextDelay * 2));
		this.schedule(this.nextDelay);
	}
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-lion-rpc-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function createLionRpcRunner(opts: LionRpcRunnerOptions) {
	return async (req: LionRunRequest): Promise<LionRunOutput> => runRpcOnce(req, opts);
}

async function runRpcOnce(req: LionRunRequest, opts: LionRpcRunnerOptions): Promise<LionRunOutput> {
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	let client: LionRpcClient | null = null;
	let poller: AdaptivePoller | null = null;
	let deliveryPromise: Promise<boolean> | null = null;
	let channelOpen = true;
	let steeringClosedHook: Promise<void> = Promise.resolve();
	let processExitNotified = false;
	const notifyProcessExit = () => {
		if (processExitNotified) return;
		processExitNotified = true;
		try { req.onProcessExit?.(); } catch { /* best effort */ }
	};
	const progressState = createLionProgressState({ includeText: req.include_progress_text ?? false });
	const closeSteeringChannel = () => {
		if (!channelOpen) return;
		channelOpen = false;
		poller?.stop();
		try { req.onControlClosed?.(); } catch { /* best effort */ }
		steeringClosedHook = Promise.resolve(opts.onSteeringClosed?.()).then(() => undefined);
	};

	const deliverPending = async (): Promise<boolean> => {
		if (deliveryPromise) return deliveryPromise;
		if (!channelOpen || !client) return false;
		deliveryPromise = (async () => {
			const activeClient = client;
			if (!activeClient) return false;
			const { result: hasPending } = await opts.store.query((l) => l.hasPendingSteering(req.run.id));
			if (!hasPending) return false;
			const { result: messages } = await opts.store.mutate((l) => l.reservePendingSteering(req.run.id));
			for (const msg of messages) {
				try {
					await activeClient.steer(msg.message);
					await opts.store.mutate((l) => l.markSteeringDelivered(req.run.id, msg.id));
				} catch (err) {
					await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, `RPC steer failed: ${err instanceof Error ? err.message : String(err)}`));
				}
			}
			return messages.length > 0;
		})().finally(() => { deliveryPromise = null; });
		return deliveryPromise;
	};

	const waitForInFlightDelivery = async () => {
		const inFlight: Promise<boolean> | null = deliveryPromise;
		if (inFlight) await inFlight.catch(() => undefined);
	};

	try {
		const tmp = await writePromptToTempFile(req.run.agent_id, buildLionSystemPrompt(req.run));
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		client = await (opts.clientFactory ?? createDefaultRpcClient)({
			cwd: opts.cwd,
			model: req.run.model,
			tools: req.run.tools,
			systemPromptPath: tmpPath,
			extraArgs: opts.extraArgs,
		});

		client.onEvent((event) => {
			const progress = progressFromEvent(event, progressState);
			if (progress) {
				try { req.onProgress?.(progress); } catch { /* progress callbacks must not break runner */ }
			}
		});
		await client.start();
		const info = client.getProcessInfo?.();
		if (info?.pid) {
			try {
				req.onProcessStart?.({
					...info,
					cancel: async () => {
						await client?.abort();
						await client?.stop();
					},
					isAlive: () => Boolean(client),
				});
			} catch { /* process metadata is best-effort */ }
		}

		poller = new AdaptivePoller(deliverPending, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS);
		poller.start();
		const idle = client.waitForIdle(req.timeout_ms).finally(closeSteeringChannel);
		await client.prompt(buildLionUserPrompt(req.run));
		if (await deliverPending()) poller.wake();
		await raceAbort(idle, req.signal, async () => {
			try { await client?.abort(); } catch { /* best effort */ }
		});
		closeSteeringChannel();
		await steeringClosedHook;
		await waitForInFlightDelivery();
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, "run finished before pending steering could be delivered"));
		const text = (await client.getLastAssistantText()) ?? "";
		const report: LionReport | null = parseLionReport(text);
		return { text, report };
	} catch (err) {
		notifyProcessExit();
		closeSteeringChannel();
		await steeringClosedHook.catch(() => undefined);
		await waitForInFlightDelivery();
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, `RPC runner stopped before delivery: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
		throw err;
	} finally {
		notifyProcessExit();
		closeSteeringChannel();
		poller?.stop();
		if (client) {
			try { await client.stop(); } catch { /* ignore */ }
		}
		if (tmpPath)
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir)
			try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Promise<void>): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		await onAbort();
		throw new Error("LION RPC runner was aborted");
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			fn();
		};
		const abort = () => {
			void onAbort().finally(() => finish(() => reject(new Error("LION RPC runner was aborted"))));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => finish(() => resolve(value)), (err) => finish(() => reject(err)));
	});
}

async function createDefaultRpcClient(config: LionRpcClientConfig): Promise<LionRpcClient> {
	const mod = await import("@earendil-works/pi-coding-agent");
	const cliPath = path.join(mod.getPackageDir(), "dist", "cli.js");
	const args = ["--no-session", "--append-system-prompt", config.systemPromptPath, ...(config.extraArgs ?? [])];
	if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
	const client = new mod.RpcClient({ cliPath, cwd: config.cwd, model: config.model ?? undefined, args });
	return {
		start: () => client.start(),
		stop: () => client.stop(),
		prompt: (message) => client.prompt(message),
		steer: (message) => client.steer(message),
		abort: () => client.abort(),
		waitForIdle: (timeout) => client.waitForIdle(timeout),
		getLastAssistantText: () => client.getLastAssistantText(),
		onEvent: (listener) => client.onEvent(listener as never),
		getStderr: () => client.getStderr(),
		getProcessInfo: () => {
			const proc = (client as unknown as { process?: { pid?: number } | null }).process;
			return typeof proc?.pid === "number" ? { pid: proc.pid, pgid: null } : null;
		},
	};
}
