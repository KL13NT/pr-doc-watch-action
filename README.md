# Documentation Link Checker

A GitHub Action that scans pull request files for links in code comments and validates them.

## Features

- Detects links in comments across multiple languages (C-style, Python, HTML, SQL)
- Validates absolute URLs (HTTP/HTTPS)
- Checks relative file paths for existence
- Posts customizable PR comments
- Smart detection: identifies when all docs are updated

## Usage

### Basic Setup

Create `.github/workflows/check-links.yml`:

```yaml
name: Check Documentation Links

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  check-links:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Check documentation links
        uses: your-username/doc-link-checker@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Custom Templates

Create three template files in `.github/`:

**`.github/comment-template.md`** - Standard report with links:

```markdown
# Code Links Report

This PR potentially affects {{LINK_COUNT}} links.

## ❌ Broken links

{{BROKEN_LINKS}}

## ❔ Links to review

{{VALID_LINKS}}
```

**`.github/no-links-template.md`** - When no links found:

```markdown
# Code Links Report

**✔ No documentation actions required!**

This PR does not affect files with active links to any documentation. Fire away!
```

**`.github/all-updated-template.md`** - When all linked docs are updated:

```markdown
# Code Links Report

**✔ All linked documentation has been touched!**

Good job! This PR has touched all linked documentation files.

P.S. This does not guarantee the docs were updated correctly. You should review the documentation updates as well.
```

### Custom Template Path

```yaml
- uses: your-username/doc-link-checker@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    template-path: .github/custom-templates
```

## Inputs

| Input           | Description                    | Required | Default               |
| --------------- | ------------------------------ | -------- | --------------------- |
| `github-token`  | GitHub token for API access    | No       | `${{ github.token }}` |
| `template-path` | Directory containing templates | No       | `.github`             |

## Template Placeholders

- `{{LINK_COUNT}}` - Total number of links found
- `{{BROKEN_LINKS}}` - List of broken/invalid links
- `{{VALID_LINKS}}` - List of valid links to review

## Supported Comment Styles

- `//` - C-style single line (JavaScript, Java, C++, Rust, Go)
- `/* */` - C-style multi-line
- `#` - Python, Ruby, Shell, YAML
- `<!-- -->` - HTML, XML
- `--` - SQL

## Example Output

The action posts comments like:

```markdown
# Code Links Report

This PR potentially affects 3 links.

## ❌ Broken links

❌ `./missing-doc.md` (relative)
Resolves to: `src/missing-doc.md`
File not found in repository
Referenced in: [`src/app.js`](...)

## ❔ Links to review

- `https://api.example.com/docs` (absolute)
  Referenced in: [`src/app.js`](...)
```

## License

MIT
