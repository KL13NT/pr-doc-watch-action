import { execSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

interface CommentPattern {
  name: string;
  regex: RegExp;
}

interface LinkStatus {
  valid: boolean | 'unknown';
  message?: string;
  statusCode?: number;
  resolvedPath?: string;
}

interface Link {
  url: string;
  type: 'absolute' | 'relative';
  status: LinkStatus;
}

interface FileResult {
  filename: string;
  links: Link[];
}

// Comment patterns for different languages
const COMMENT_PATTERNS: CommentPattern[] = [
  { name: 'C-style single', regex: /\/\/(.*)$/gm },
  { name: 'C-style multi', regex: /\/\*[\s\S]*?\*\//g },
  { name: 'Hash', regex: /#(.*)$/gm },
  { name: 'HTML', regex: /<!--[\s\S]*?-->/g },
  { name: 'SQL', regex: /--(.*)$/gm },
];

// URL pattern - matches http(s) URLs and relative paths
const URL_PATTERN = /(?:https?:\/\/[^\s<>"'{}|\\^`\[\]]+|(?:\.\.?\/|\/)[^\s<>"'{}|\\^`\[\]]+)/g;

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split('/');
  const prNumber = process.env.PR_NUMBER || getPRNumberFromEvent();
  const sha = process.env.GITHUB_SHA!;

  console.log(`Checking PR #${prNumber} in ${owner}/${repo}`);

  const files = getChangedFiles();
  console.log(`Found ${files.length} changed files`);

  const results = await parseFilesForLinks(files);

  await postCommentFromTemplate(owner, repo, prNumber!, sha, results, files);
}

function getChangedFiles(): string[] {
  try {
    const output = execSync('git diff --name-only origin/$GITHUB_BASE_REF...HEAD', {
      encoding: 'utf8',
    });

    return output
      .trim()
      .split('\n')
      .filter(f => {
        if (!f || !fs.existsSync(f)) return false;
        if (f.startsWith('.github/') || f.startsWith('src/') || f.startsWith('dist/')) return false;
        return true;
      });
  } catch (error) {
    console.error('Error getting changed files:', (error as Error).message);
    return [];
  }
}

async function parseFilesForLinks(files: string[]): Promise<FileResult[]> {
  const results: FileResult[] = [];

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

function getFileContent(filepath: string): string | null {
  try {
    return fs.readFileSync(filepath, 'utf8');
  } catch (error) {
    console.error(`Error reading ${filepath}:`, (error as Error).message);
    return null;
  }
}

function extractComments(content: string): string[] {
  const allComments: string[] = [];

  for (const pattern of COMMENT_PATTERNS) {
    const matches = content.match(pattern.regex);
    if (matches) {
      allComments.push(...matches);
    }
  }

  return allComments;
}

function extractLinks(comments: string[]): string[] {
  const links = new Set<string>();

  for (const comment of comments) {
    const matches = comment.match(URL_PATTERN);
    if (matches) {
      matches.forEach(link => {
        const cleaned = link.trim();
        if (cleaned !== '//' && cleaned !== '/*' && cleaned !== '*/' && 
            cleaned !== '#' && cleaned !== '--' && cleaned !== '<!--') {
          links.add(cleaned);
        }
      });
    }
  }

  return Array.from(links);
}

async function checkLinks(links: string[], filename: string): Promise<Link[]> {
  const results: Link[] = [];

  for (const link of links) {
    const status = await checkLinkValidity(link, filename);
    results.push({
      url: link,
      type: link.startsWith('http') ? 'absolute' : 'relative',
      status,
    });
  }

  return results;
}

async function checkLinkValidity(url: string, sourceFile: string): Promise<LinkStatus> {
  if (!url.startsWith('http')) {
    const resolvedPath = path.resolve(process.cwd(), path.dirname(sourceFile), url);
    const exists = fs.existsSync(resolvedPath);
    
    return { 
      valid: exists, 
      message: exists ? 'File exists' : 'File not found in repository',
      resolvedPath: path.relative(process.cwd(), resolvedPath)
    };
  }

  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    
    const req = client.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
        resolve({ valid: true, statusCode: res.statusCode });
      } else {
        resolve({ valid: false, statusCode: res.statusCode });
      }
    });

    req.on('error', (error) => {
      resolve({ valid: false, message: error.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, message: 'Timeout' });
    });
  });
}

async function postCommentFromTemplate(
  owner: string,
  repo: string,
  prNumber: string,
  sha: string,
  results: FileResult[],
  changedFiles: string[]
): Promise<void> {
  let templateName: string;
  
  if (results.length === 0) {
    templateName = 'no-links-template.md';
  } else {
    const allLinksRelativeAndTouched = checkAllLinksUpdated(results, changedFiles);
    templateName = allLinksRelativeAndTouched ? 'all-updated-template.md' : 'comment-template.md';
  }

  const templatePath = process.env.TEMPLATE_PATH || `.github/${templateName}`;
  let template: string;
  
  try {
    template = fs.readFileSync(templatePath, 'utf8');
  } catch (error) {
    console.error(`Template not found: ${templatePath}, using default format`);
    template = getDefaultTemplate(results.length === 0);
  }

  if (results.length > 0 && templateName === 'comment-template.md') {
    let brokenLinksMarkdown = '';
    let validLinksMarkdown = '';
    
    for (const result of results) {
      const fileUrl = `https://github.com/${owner}/${repo}/blob/${sha}/${result.filename}`;
      const fileLink = `[\`${result.filename}\`](${fileUrl})`;
      
      const invalidLinks = result.links.filter(l => l.status.valid === false);
      const validLinks = result.links.filter(l => l.status.valid === true);

      for (const link of invalidLinks) {
        brokenLinksMarkdown += `❌ \`${link.url}\` (${link.type})\n`;
        
        if (link.type === 'relative' && link.status.resolvedPath) {
          brokenLinksMarkdown += `   Resolves to: \`${link.status.resolvedPath}\`\n`;
        }
        
        if (link.status.statusCode) {
          brokenLinksMarkdown += `   Status: ${link.status.statusCode}\n`;
        } else if (link.status.message) {
          brokenLinksMarkdown += `   ${link.status.message}\n`;
        }
        
        brokenLinksMarkdown += `   Referenced in: ${fileLink}\n\n`;
      }

      for (const link of validLinks) {
        validLinksMarkdown += `- \`${link.url}\` (${link.type})\n`;
        
        if (link.type === 'relative' && link.status.resolvedPath) {
          const resolvedFileUrl = `https://github.com/${owner}/${repo}/blob/${sha}/${link.status.resolvedPath}`;
          validLinksMarkdown += `  → [\`${link.status.resolvedPath}\`](${resolvedFileUrl})\n`;
        }
        
        validLinksMarkdown += `  Referenced in: ${fileLink}\n\n`;
      }
    }

    if (!brokenLinksMarkdown) {
      brokenLinksMarkdown = 'No broken links found. ✅\n\n';
    }

    if (!validLinksMarkdown) {
      validLinksMarkdown = 'No additional links to review.\n\n';
    }

    const totalLinks = results.reduce((sum, r) => sum + r.links.length, 0);

    template = template
      .replace('{{LINK_COUNT}}', totalLinks.toString())
      .replace('{{BROKEN_LINKS}}', brokenLinksMarkdown)
      .replace('{{VALID_LINKS}}', validLinksMarkdown);
  }

  const tempFile = '/tmp/pr-comment.md';
  fs.writeFileSync(tempFile, template);

  execSync(`gh pr comment ${prNumber} --body-file ${tempFile}`, {
    stdio: 'inherit',
  });

  console.log('Comment posted to PR');
}

function checkAllLinksUpdated(results: FileResult[], changedFiles: string[]): boolean {
  const changedFilePaths = changedFiles.map(f => path.resolve(f));
  
  for (const result of results) {
    for (const link of result.links) {
      if (link.type === 'absolute') {
        return false;
      }
      
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

function getDefaultTemplate(noLinks: boolean): string {
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

function getPRNumberFromEvent(): string | null {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH!;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    return event.pull_request?.number || event.number;
  } catch (error) {
    return null;
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});