import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isMissing, mutateFile, readOptional } from "./storage.js";

const approvalPath = (): string => join(getAgentDir(), "memory", "project-approvals.json");
const parseApprovals = (raw: string | undefined): Record<string, boolean> => {
	if (raw === undefined) return {};
	const data = JSON.parse(raw);
	if (!data || typeof data !== "object" || Array.isArray(data) || Object.entries(data).some(([key, value]) => !isAbsolute(key) || typeof value !== "boolean")) {
		throw new Error(`Invalid project-memory approvals: ${approvalPath()}`);
	}
	return data;
};

export type ProjectApproval = { approved: boolean; hostTrusted: boolean; canonicalProject?: string; source: string; approvalFile: string };

/** Host true alone is insufficient: resource-free projects are auto-trusted by Pi. */
export async function projectApproval(projectRoot: string, hostTrusted: boolean, cwd = projectRoot): Promise<ProjectApproval> {
	const base = { approved: false, hostTrusted, approvalFile: approvalPath() };
	if (!hostTrusted) return { ...base, source: "host project trust inactive" };
	let canonicalProject: string;
	try { canonicalProject = await realpath(projectRoot); }
	catch (error) { if (isMissing(error)) return { ...base, source: "project directory absent" }; throw error; }
	const status = { ...base, canonicalProject };
	const own = parseApprovals(await readOptional(approvalPath()))[canonicalProject];
	if (own === false) return { ...status, source: "project-memory approval explicitly revoked" };
	// A resource-gated decision for the source root is affirmative. A decision for
	// a nested cwd does not authorize automatically loading its ancestor's memory.
	if (await realpath(cwd) === canonicalProject && hasTrustRequiringProjectResources(cwd)) {
		return { ...status, approved: true, source: "active host trust for resource-gated project root" };
	}
	// Supported host API, with an existence check to avoid creating a store during audit.
	const trustFile = await lstat(join(getAgentDir(), "trust.json")).catch((error) => { if (!isMissing(error)) throw error; return undefined; });
	const saved = trustFile ? new ProjectTrustStore(getAgentDir()).getEntry(canonicalProject) : null;
	if (saved?.decision === false) return { ...status, source: `host saved denial: ${saved.path}` };
	if (own === true) return { ...status, approved: true, source: "explicit local project-memory approval" };
	if (saved?.decision === true) return { ...status, approved: true, source: `host saved approval: ${saved.path}` };
	return { ...status, source: "no affirmative approval; use /memory approve-project in the TUI" };
}

/** Called only after interactive command confirmation; never exposed through the model tool. */
export async function setProjectApproval(projectRoot: string, approved: boolean): Promise<void> {
	const canonical = await realpath(projectRoot);
	await withFileMutationQueue(approvalPath(), () => mutateFile(approvalPath(), (raw) => JSON.stringify({ ...parseApprovals(raw), [canonical]: approved }, null, 2) + "\n"));
}
