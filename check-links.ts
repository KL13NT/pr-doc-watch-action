const { execSync } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Comment patterns for different languages
const COMMENT_PATTERNS = [
	{ name: "C-style single", regex: /\/\/(.*)$/gm },
	{ name: "C-style multi", regex: /\/\*[\s\S]*?\*\//g },
	{ name: "Hash", regex: /#(.*)$/gm },
	{ name: "HTML", regex: /<!--[\s\S]*?-->/g },
	{ name: "SQL", regex: /--(.*)$/gm },
];

// URL pattern - matches http(s) URLs and relative paths
const URL_PATTERN =
	/(?:https?:\/\/[^\s<>"{}|\\^`\[\]]+|(?:\.\.?\/|\/)[^\s<>"{}|\\^`\[\]]+)/g;

async function main() {
	if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_SHA) {
		console.error("GITHUB_REPOSITORY environment variable is not set");
		process.exit(1);
	}

	const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
	const prNumber = process.env.PR_NUMBER || getPRNumberFromEvent();
	const sha = process.env.GITHUB_SHA;

	console.log(`Checking PR #${prNumber} in ${owner}/${repo}`);

	// Get changed files using git diff
	const files = getChangedFiles();
	console.log(`Found ${files.length} changed files`);

	// Parse comments and extract links
	const results = await parseFilesForLinks(files);

	// Post comment to PR using appropriate template
	await postCommentFromTemplate({
		owner,
		repo,
		prNumber,
		sha,
		results,
		changedFiles: files,
	});
}

function getChangedFiles() {
	try {
		// Get list of changed files in the PR
		const output: string = execSync(
			"git diff --name-only origin/$GITHUB_BASE_REF...HEAD",
			{
				encoding: "utf8",
			},
		);

		return output
			.trim()
			.split("\n")
			.filter((f) => f && fs.existsSync(f));
	} catch (error) {
		console.error("Error getting changed files:", error.message);
		return [];
	}
}

async function parseFilesForLinks(files) {
	const results: {
		filename: string;
		links: Awaited<ReturnType<typeof checkLinks>>;
	}[] = [];

	for (const file of files) {
		console.log(`Processing: ${file}`);

		const content = getFileContent(file);
		if (!content) continue;

		const comments = extractComments(content);
		const links = extractLinks(comments);

		if (links.length > 0) {
			const linkStatuses = await checkLinks(links, file);

			results.push({
				filename: file,
				links: linkStatuses,
			});
		}
	}

	return results;
}

function getFileContent(filepath) {
	try {
		return fs.readFileSync(filepath, "utf8");
	} catch (error) {
		console.error(`Error reading ${filepath}:`, error.message);
		return null;
	}
}

function extractComments(content: string) {
	const allComments: string[] = [];

	for (const pattern of COMMENT_PATTERNS) {
		const matches = content.match(pattern.regex);
		if (matches) {
			allComments.push(...matches);
		}
	}

	return allComments;
}

function extractLinks(comments: string[]) {
	const links = new Set<string>();

	for (const comment of comments) {
		const matches = comment.match(URL_PATTERN);
		if (matches) {
			matches.forEach((link) => {
				links.add(link.trim());
			});
		}
	}

	return Array.from(links);
}

async function checkLinks(links: string[], filename: string) {
	const results: { url: string; type: "absolute" | "relative"; status: any }[] =
		[];

	for (const link of links) {
		const status = await checkLinkValidity(link, filename);
		results.push({
			url: link,
			type: link.startsWith("http") ? "absolute" : "relative",
			status,
		});
	}

	return results;
}

async function checkLinkValidity(url, sourceFile) {
	// Check relative paths for file existence
	if (!url.startsWith("http")) {
		const resolvedPath = path.resolve(path.dirname(sourceFile), url);
		const exists = fs.existsSync(resolvedPath);

		return {
			valid: exists,
			message: exists ? "File exists" : "File not found in repository",
			resolvedPath: path.relative(process.cwd(), resolvedPath),
		};
	}

	return new Promise((resolve) => {
		const client = url.startsWith("https") ? https : http;

		const req = client.get(url, { timeout: 5000 }, (res) => {
			if (res.statusCode >= 200 && res.statusCode < 400) {
				resolve({ valid: true, statusCode: res.statusCode });
			} else {
				resolve({ valid: false, statusCode: res.statusCode });
			}
		});

		req.on("error", (error) => {
			resolve({ valid: false, message: error.message });
		});

		req.on("timeout", () => {
			req.destroy();
			resolve({ valid: false, message: "Timeout" });
		});
	});
}

async function postCommentFromTemplate({
	owner,
	repo,
	prNumber,
	sha,
	results,
	changedFiles,
}: {
	owner: string;
	repo: string;
	prNumber?: string;
	sha: string;
	results: any[];
	changedFiles: string[];
}) {
	// Determine which template to use
	let templateName: string;

	// No links found at all
	if (results.length === 0) {
		templateName = "no-links-template.md";
	} else {
		// Check if all links are relative and all referenced files are in the PR
		const allLinksRelativeAndTouched = checkAllLinksUpdated(
			results,
			changedFiles,
		);

		if (allLinksRelativeAndTouched) {
			templateName = "all-updated-template.md";
		} else {
			templateName = "comment-template.md";
		}
	}

	// Read template file
	const templatePath = process.env.TEMPLATE_PATH || `.github/${templateName}`;
	let template: string;

	try {
		template = fs.readFileSync(templatePath, "utf8");
	} catch (error) {
		console.error(`Template not found: ${templatePath}, using default format`);
		template = getDefaultTemplate(results.length === 0);
	}

	// For the default template with links, build the content
	if (results.length > 0 && templateName === "comment-template.md") {
		// Collect all broken and valid links
		let brokenLinksMarkdown = "";
		let validLinksMarkdown = "";

		for (const result of results) {
			// Create GitHub link to file
			const fileUrl = `https://github.com/${owner}/${repo}/blob/${sha}/${result.filename}`;
			const fileLink = `[\`${result.filename}\`](${fileUrl})`;

			// Separate invalid and valid links
			const invalidLinks = result.links.filter((l) => l.status.valid === false);
			const validLinks = result.links.filter((l) => l.status.valid === true);

			// Build broken links section
			for (const link of invalidLinks) {
				brokenLinksMarkdown += `❌ \`${link.url}\` (${link.type})\n`;

				if (link.type === "relative" && link.status.resolvedPath) {
					brokenLinksMarkdown += `   Resolves to: \`${link.status.resolvedPath}\`\n`;
				}

				if (link.status.statusCode) {
					brokenLinksMarkdown += `   Status: ${link.status.statusCode}\n`;
				} else if (link.status.message) {
					brokenLinksMarkdown += `   ${link.status.message}\n`;
				}

				brokenLinksMarkdown += `   Referenced in: ${fileLink}\n\n`;
			}

			// Build valid links section
			for (const link of validLinks) {
				validLinksMarkdown += `- \`${link.url}\` (${link.type})\n`;

				if (link.type === "relative" && link.status.resolvedPath) {
					validLinksMarkdown += `  → \`${link.status.resolvedPath}\`\n`;
				}

				validLinksMarkdown += `  Referenced in: ${fileLink}\n\n`;
			}
		}

		// If no broken links, add a message
		if (!brokenLinksMarkdown) {
			brokenLinksMarkdown = "No broken links found. ✅\n\n";
		}

		// If no valid links to review, add a message
		if (!validLinksMarkdown) {
			validLinksMarkdown = "No additional links to review.\n\n";
		}

		// Count total links
		const totalLinks = results.reduce((sum, r) => sum + r.links.length, 0);

		// Replace placeholders in template
		template = template
			.replace("{{LINK_COUNT}}", totalLinks)
			.replace("{{BROKEN_LINKS}}", brokenLinksMarkdown)
			.replace("{{VALID_LINKS}}", validLinksMarkdown);
	}

	// Write comment to temp file
	const tempFile = "/tmp/pr-comment.md";
	fs.writeFileSync(tempFile, template);

	// Post comment using GitHub CLI
	execSync(`gh pr comment ${prNumber} --body-file ${tempFile}`, {
		stdio: "inherit",
	});

	console.log("Comment posted to PR");
}

function checkAllLinksUpdated(results, changedFiles) {
	const changedFilePaths = changedFiles.map((f) => path.resolve(f));

	for (const result of results) {
		for (const link of result.links) {
			// If any link is absolute, return false
			if (link.type === "absolute") {
				return false;
			}

			// If any relative link's resolved path is not in changed files, return false
			if (link.status.resolvedPath) {
				const resolvedFullPath = path.resolve(link.status.resolvedPath);
				if (!changedFilePaths.includes(resolvedFullPath)) {
					return false;
				}
			}
		}
	}

	return true;
}

function getDefaultTemplate(noLinks) {
	if (noLinks) {
		return `# Code Links Report

**✔ No documentation actions required!**

This PR does not affect files with active links to any documentation. Fire away!`;
	}

	return `# Code Links Report

This PR potentially affects {{LINK_COUNT}} links.

## ❌ Broken links

{{BROKEN_LINKS}}

## ❔ Links to review

{{VALID_LINKS}}`;
}

function getPRNumberFromEvent() {
	try {
		const eventPath = process.env.GITHUB_EVENT_PATH;
		const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
		return event.pull_request?.number || event.number;
	} catch (error) {
		return null;
	}
}

// Run the script
main().catch((error) => {
	console.error("Error:", error);
	process.exit(1);
});
