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
import { buildLionSystemPrompt, buildLionUserPrompt, createLionProgressState, isPidAlive, parseLionReport, progressFromEvent, type LionProcessInfo, type LionRunOutput, type LionRunRequest } from "./subprocess.ts";

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
	/** Maximum wait for graceful RPC abort before stop is attempted. */
	abortGraceMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2000;
const DEFAULT_ABORT_GRACE_MS = 1000;

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
	if (req.signal?.aborted) throw new Error("LION RPC runner was aborted before prompt");
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	let client: LionRpcClient | null = null;
	let poller: AdaptivePoller | null = null;
	let deliveryPromise: Promise<boolean> | null = null;
	let stopPromise: Promise<void> | null = null;
	let unsubscribeEvents: (() => void) | null = null;
	let channelOpen = true;
	let childExited = false;
	let ownedCancellationRequested = false;
	let ownedCancellationPromise: Promise<void> | null = null;
	let steeringClosedHook: Promise<void> = Promise.resolve();
	let processExitNotified = false;
	const notifyProcessExit = () => {
		if (processExitNotified) return;
		processExitNotified = true;
		try { req.onProcessExit?.(); } catch { /* best effort */ }
	};
	const stopClient = async () => {
		const activeClient = client;
		if (!activeClient) return;
		stopPromise ??= Promise.resolve().then(() => activeClient.stop()).finally(() => { childExited = true; });
		return stopPromise;
	};
	const abortAndStop = async (activeClient: LionRpcClient) => {
		let abortError: unknown;
		try {
			await withTimeout(activeClient.abort(), opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "RPC abort timed out");
		} catch (err) {
			abortError = err;
		}
		let stopError: unknown;
		try { await stopClient(); } catch (err) { stopError = err; }
		if (abortError) throw abortError;
		if (stopError) throw stopError;
	};
	const progressState = createLionProgressState({ includeText: req.include_progress_text ?? false });
	const closeSteeringChannel = () => {
		if (!channelOpen) return;
		channelOpen = false;
		poller?.stop();
		try { req.onControlClosed?.(); } catch { /* best effort */ }
		steeringClosedHook = Promise.resolve(opts.onSteeringClosed?.()).then(() => undefined);
	};
	const failReserved = async (messages: Array<{ id: string }>, reason: string) => {
		for (const msg of messages) {
			await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, reason)).catch(() => undefined);
		}
	};

	const deliverPending = async (): Promise<boolean> => {
		if (deliveryPromise) return deliveryPromise;
		if (!channelOpen || !client) return false;
		deliveryPromise = (async () => {
			const activeClient = client;
			if (!activeClient) return false;
			const { result: hasPending } = await opts.store.query((l) => l.hasPendingSteering(req.run.id));
			if (!channelOpen || !hasPending) return false;
			const { result: messages } = await opts.store.mutate((l) => l.reservePendingSteering(req.run.id));
			if (!channelOpen) {
				await failReserved(messages, "RPC steering channel closed before delivery");
				return false;
			}
			for (const msg of messages) {
				if (!channelOpen) {
					await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, "RPC steering channel closed before delivery")).catch(() => undefined);
					continue;
				}
				try {
					// No await may occur between this final gate check and issuing steer().
					const steering = activeClient.steer(msg.message);
					await steering;
					await opts.store.mutate((l) => l.markSteeringDelivered(req.run.id, msg.id));
				} catch (err) {
					await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, `RPC steer failed: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
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
		client = await (opts.clientFactory ?? createDefaultRpcClient)({ cwd: opts.cwd, model: req.run.model, tools: req.run.tools, systemPromptPath: tmpPath, extraArgs: opts.extraArgs });
		const activeClient = client;

		unsubscribeEvents = activeClient.onEvent((event) => {
			const progress = progressFromEvent(event, progressState);
			if (progress) {
				try { req.onProgress?.(progress); } catch { /* progress callbacks must not break runner */ }
			}
		});
		await activeClient.start();
		const info = activeClient.getProcessInfo?.();
		if (info?.pid) {
			const processIsAlive = info.isAlive ?? (() => !childExited);
			try {
				req.onProcessStart?.({
					...info,
					cancel: async () => {
						if (!processIsAlive()) return false;
						ownedCancellationRequested = true;
						ownedCancellationPromise ??= abortAndStop(activeClient);
						await ownedCancellationPromise;
						return true;
					},
					isAlive: () => !childExited && processIsAlive(),
				});
			} catch { /* process metadata is best-effort */ }
		}

		await raceAbort(activeClient.prompt(buildLionUserPrompt(req.run)), req.signal, () => abortAndStop(activeClient));
		poller = new AdaptivePoller(deliverPending, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS);
		poller.start();
		const idle = activeClient.waitForIdle(req.timeout_ms).finally(closeSteeringChannel);
		void idle.catch(() => undefined);
		if (await deliverPending()) poller.wake();
		await raceAbort(idle, req.signal, () => abortAndStop(activeClient));
		if (ownedCancellationRequested) {
			await ownedCancellationPromise;
			throw new Error("LION RPC runner was cancelled");
		}
		closeSteeringChannel();
		await steeringClosedHook;
		await waitForInFlightDelivery();
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, "run finished before pending steering could be delivered"));
		const text = (await activeClient.getLastAssistantText()) ?? "";
		const report: LionReport | null = parseLionReport(text);
		return { text, report };
	} catch (err) {
		closeSteeringChannel();
		await steeringClosedHook.catch(() => undefined);
		await waitForInFlightDelivery();
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, `RPC runner stopped before delivery: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
		throw err;
	} finally {
		closeSteeringChannel();
		poller?.stop();
		try { unsubscribeEvents?.(); } catch { /* ignore */ }
		try { await stopClient(); } catch { /* original runner outcome wins */ }
		notifyProcessExit();
		if (tmpPath)
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir)
			try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), Math.max(0, timeoutMs));
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
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
			void onAbort().then(
				() => finish(() => reject(new Error("LION RPC runner was aborted"))),
				(err) => finish(() => reject(err)),
			);
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
			const proc = (client as unknown as { process?: { pid?: number; exitCode?: number | null; signalCode?: string | null } | null }).process;
			if (typeof proc?.pid !== "number") return null;
			const pid = proc.pid;
			return { pid, pgid: null, isAlive: () => proc.exitCode == null && proc.signalCode == null && isPidAlive(pid) };
		},
	};
}
