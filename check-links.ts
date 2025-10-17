import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface CommentPattern {
	name: string;
	regex: RegExp;
}

interface Link {
	url: string;
	type: LinkType;
}

interface FileResult {
	filename: string;
	links: Link[];
}

enum LinkType {
	Absolute = "absolute",
	Relative = "relative",
}

enum Template {
	NoLinks = "no-links",
	AllUpdated = "all-updated",
	Pending = "pending",
}

const templatePathsMap = {
	[Template.NoLinks]: path.resolve(
		process.env.ACTION_PATH,
		"templates/no-links.md",
	),
	[Template.AllUpdated]: path.resolve(
		process.env.ACTION_PATH,
		"templates/all-updated.md",
	),
	[Template.Pending]: path.resolve(
		process.env.ACTION_PATH,
		"templates/pending.md",
	),
} as const;

// Comment patterns for different languages
const COMMENT_PATTERNS: CommentPattern[] = [
	{ name: "C-style single", regex: /^\/\/(?<url>.*)/gm },
	{ name: "C-style multi", regex: /^\/\*(?<url>[\s\S]*?)\*\//gm },
	{ name: "Hash", regex: /^#(?<url>.*)/gm },
	{ name: "HTML", regex: /^<!--(?<url>[\s\S]*?)-->/gm },
	{ name: "SQL", regex: /^--(?<url>.*)/gm },
] as const;

// URL patterns - separated for clarity
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s<>"'{}|\\^`[\]]+/g;
const RELATIVE_PATH_PATTERN = /(?:\.\.?\/|\/)[^\s<>"'{}|\\^`[\]]+/g;

async function main(): Promise<void> {
	const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
	const prNumber = process.env.PR_NUMBER || getPRNumberFromEvent();
	const sha = process.env.GITHUB_SHA;

	if (!prNumber) {
		throw new Error("PR number not found");
	}

	console.log(`Checking PR #${prNumber} in ${owner}/${repo}`);

	const files = getChangedFiles();
	console.log(`Found ${files.length} changed files`);

	const results = await parseFilesForLinks(files);

	const compiledTemplate = await compileTemplateFromLinks(
		owner,
		repo,
		sha,
		results,
		files,
	);

	postComment(compiledTemplate, prNumber);
}

function getChangedFiles(): string[] {
	try {
		const output = execSync(
			"git diff --name-only origin/$GITHUB_BASE_REF...HEAD",
			{
				encoding: "utf8",
			},
		);

		return output
			.trim()
			.split("\n")
			.filter((f) => {
				if (!f || !fs.existsSync(f)) return false;
				if (f.startsWith(".github/")) return false;
				return true;
			});
	} catch (error) {
		console.error("Error getting changed files:", (error as Error).message);
		return [];
	}
}

async function parseFilesForLinks(files: string[]) {
	return files
		.map((file) => {
			console.log(`Processing: ${file}`);

			const content = getFileContent(file);
			if (!content) {
				return null;
			}

			const comments = extractComments(content);
			const links = extractLinks(comments);

			if (links.length === 0) {
				return null;
			}

			const linkData = links.map(
				(link) =>
					({
						url: link,
						type: link.startsWith("http")
							? LinkType.Absolute
							: LinkType.Relative,
					}) as Link,
			);

			return {
				filename: file,
				links: linkData,
			} as FileResult;
		})
		.filter((file) => file !== null);
}

function getFileContent(filepath: string): string | null {
	try {
		return fs.readFileSync(filepath, "utf8");
	} catch (error) {
		console.error(`Error reading ${filepath}:`, (error as Error).message);
		return null;
	}
}

function extractComments(content: string): string[] {
	const allComments: string[] = [];

	for (const pattern of COMMENT_PATTERNS) {
		const matches = [...content.matchAll(pattern.regex)]
			.map((match) => match.groups?.url.trim())
			.filter((match) => match !== undefined);

		if (matches) {
			allComments.push(...matches);
		}
	}

	return allComments;
}

function extractLinks(comments: string[]): string[] {
	const links = new Set<string>();

	for (const comment of comments) {
		// Remove comment syntax first to avoid false matches
		const cleanComment = comment
			.replace(/^\/\//, "")
			.replace(/^\/\*|\*\/$/g, "")
			.replace(/^#/, "")
			.replace(/^--/, "")
			.replace(/^<!--/, "")
			.replace(/-->$/, "");

		// Extract absolute URLs
		const absoluteMatches = cleanComment.match(ABSOLUTE_URL_PATTERN);
		if (absoluteMatches) {
			absoluteMatches.forEach((link) => {
				links.add(link.trim());
			});
		}

		// Extract relative paths
		const relativeMatches = cleanComment.match(RELATIVE_PATH_PATTERN);
		if (relativeMatches) {
			relativeMatches.forEach((link) => {
				links.add(link.trim());
			});
		}
	}

	return Array.from(links);
}

async function compileTemplateFromLinks(
	owner: string,
	repo: string,
	sha: string,
	results: FileResult[],
	changedFiles: string[],
) {
	const allLinksRelativeAndTouched =
		results.length !== 0 && checkAllLinksUpdated(results, changedFiles);

	if (results.length === 0) {
		return executeTemplate(Template.NoLinks);
	}

	const templateName = allLinksRelativeAndTouched
		? Template.AllUpdated
		: Template.Pending;

	let linksMarkdown = "";

	for (const result of results) {
		const fileUrl = `https://github.com/${owner}/${repo}/blob/${sha}/${result.filename}`;
		const fileLink = `[\`${result.filename}\`](${fileUrl})`;

		for (const link of result.links) {
			linksMarkdown += `- \`${link.url}\` (${link.type})\n`;

			if (link.type === "relative") {
				const resolvedPath = path.resolve(
					process.cwd(),
					path.dirname(result.filename),
					link.url,
				);
				const relativePath = path.relative(process.cwd(), resolvedPath);
				const resolvedFileUrl = `https://github.com/${owner}/${repo}/blob/${sha}/${relativePath}`;
				linksMarkdown += `  → [\`${relativePath}\`](${resolvedFileUrl})\n`;
			}

			linksMarkdown += `  Referenced in: ${fileLink}\n\n`;
		}
	}

	const totalLinks = results.reduce((sum, r) => sum + r.links.length, 0);
	return executeTemplate(templateName, totalLinks, linksMarkdown);
}

const postComment = (body: string, prNumber: string): void => {
	const tempFile = "/tmp/pr-comment.md";
	fs.writeFileSync(tempFile, body);

	execSync(`gh pr comment ${prNumber} --body-file ${tempFile}`, {
		stdio: "inherit",
	});

	console.log("Comment posted to PR");
};

function checkAllLinksUpdated(
	results: FileResult[],
	changedFiles: string[],
): boolean {
	const changedFilePaths = changedFiles.map((f) => path.resolve(f));

	for (const result of results) {
		for (const link of result.links) {
			if (link.type === "absolute") {
				return false;
			}

			const resolvedPath = path.resolve(
				process.cwd(),
				path.dirname(result.filename),
				link.url,
			);
			if (!changedFilePaths.includes(resolvedPath)) {
				return false;
			}
		}
	}

	return true;
}

function executeTemplate(
	templateName: Template,
	linkCount?: number,
	linksOutput?: string,
) {
	const templatePath = templatePathsMap[templateName];
	const template = getFileContent(templatePath);

	if (!template) {
		throw new Error(`Template not found: ${templatePath}`);
	}

	return template
		.replace("{{LINK_COUNT}}", String(linkCount ?? 0))
		.replace("{{LINKS}}", linksOutput ?? "");
}

function getPRNumberFromEvent(): string | null {
	try {
		const eventPath = process.env.GITHUB_EVENT_PATH;
		const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
		return event.pull_request?.number || event.number;
	} catch {
		return null;
	}
}

main().catch((error) => {
	console.error("Error:", error);
	process.exit(0); // Intentionally 0 to not fail builds
});
