/**
 * @module agent-rules
 * Surface global/project agent rules. Contents loaded on demand.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RuleFile {
	label: string;
	path: string;
	scope: "global" | "project";
}

function findMarkdownFiles(dir: string, basePath = ""): string[] {
	if (!fs.existsSync(dir)) return [];

	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relativePath);
		}
	}
	return files.sort();
}

/**
 * Register agent-rules system-prompt hook.
 * @param pi - Pi extension API.
 */
export default function agentRulesExtension(pi: ExtensionAPI) {
	let ruleFiles: RuleFile[] = [];

	pi.on("session_start", async (_event, ctx) => {
		const globalRulesDir = path.join(os.homedir(), ".agents", "rules");
		const projectRulesDir = path.join(ctx.cwd, ".agents", "rules");

		const globalRules = findMarkdownFiles(globalRulesDir).map((file) => ({
			label: `~/.agents/rules/${file}`,
			path: path.join(globalRulesDir, file),
			scope: "global" as const,
		}));
		const projectRules = ctx.isProjectTrusted()
			? findMarkdownFiles(projectRulesDir).map((file) => ({
					label: `.agents/rules/${file}`,
					path: path.join(projectRulesDir, file),
					scope: "project" as const,
				}))
			: [];

		ruleFiles = [...globalRules, ...projectRules];

		if (ctx.hasUI && ruleFiles.length > 0) {
			ctx.ui.notify(`Found ${ruleFiles.length} agent rule(s)`, "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (ruleFiles.length === 0) return;

		const rulesList = ruleFiles
			.map((rule) => `- ${rule.label} (${rule.scope}; read path: ${rule.path})`)
			.join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`

## Agent Rules

The following agent rules are available:

${rulesList}

When editing files covered by these rules, use the read tool to load the relevant rule files before making changes.
`,
		};
	});
}
