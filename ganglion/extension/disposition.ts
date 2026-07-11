import type { AllocationReleaseDisposition } from "./store.ts";

export function formatAllocationReleaseDisposition(disposition: AllocationReleaseDisposition): string {
	switch (disposition) {
		case "released": return "capacity released";
		case "already_free": return "capacity was already free";
		case "member_unavailable": return "member has no active lease but remains unavailable";
		case "retained_by_newer_allocation": return "capacity retained by a newer allocation";
		case "not_terminal": return "no terminal capacity release";
		default: return assertNever(disposition);
	}
}

function assertNever(value: never): never {
	throw new Error(`unknown allocation release disposition: ${String(value)}`);
}
