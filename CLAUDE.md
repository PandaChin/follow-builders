# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Follow Builders is a Claude Code skill that tracks AI builders across X/Twitter, YouTube podcasts, and official AI blogs, then delivers curated digests. It is **not** a traditional application — it is a data pipeline + LLM skill with three Node.js scripts and a set of prompt templates.

## Architecture

Two-phase system:

1. **Central feed generation** (`scripts/generate-feed.js`) — runs on GitHub Actions daily at 6:17 UTC. Fetches tweets (X API v2), podcast transcripts (RSS + pod2txt), and blog posts (HTML scraping). Outputs `feed-x.json`, `feed-podcasts.json`, `feed-blogs.json` to the repo root. Deduplication state lives in `state-feed.json` (auto-pruned to 7 days).

2. **Client digest** (`scripts/prepare-digest.js` → LLM remix → `scripts/deliver.js`) — the prepare script fetches the central feeds + prompts from GitHub, reads user config from `~/.follow-builders/config.json`, and outputs a single JSON blob to stdout. The LLM remixes that JSON into a digest (it never fetches data itself). The deliver script sends the result via Telegram, email (Resend), or stdout.

The LLM's only job is remixing content from the prepare script's JSON output. It must not fetch anything from the web.

## Commands

```bash
# Install dependencies (only needed once)
cd scripts && npm install

# Generate central feeds (requires X_BEARER_TOKEN and POD2TXT_API_KEY env vars)
cd scripts && node generate-feed.js                 # all feeds
cd scripts && node generate-feed.js --tweets-only   # tweets only
cd scripts && node generate-feed.js --podcasts-only  # podcasts only
cd scripts && node generate-feed.js --blogs-only     # blogs only

# Prepare digest JSON (fetches from central feed, outputs to stdout)
cd scripts && node prepare-digest.js

# Deliver a digest
echo "digest text" | node deliver.js
node deliver.js --file /tmp/digest.txt
node deliver.js --message "digest text"
```

There are no tests, no linting, and no build step.

## Key Files

- **`SKILL.md`** — The skill definition. This is the "brain" that instructs the LLM on onboarding, digest generation, configuration handling, and delivery. Read this first for any skill-related work.
- **`config/default-sources.json`** — The curated list of podcasts (6), X accounts (26), and blogs (2). Source list is managed centrally and cannot be user-modified.
- **`config/config-schema.json`** — JSON Schema for `~/.follow-builders/config.json` (user preferences: language, timezone, frequency, delivery method).
- **`prompts/`** — Plain-English prompt templates controlling digest format. Priority order: user custom (`~/.follow-builders/prompts/`) > remote (GitHub raw) > local (`prompts/`).
- **`.github/workflows/generate-feed.yml`** — GitHub Actions workflow for daily feed generation. Supports `workflow_dispatch` with mode selection (all/tweets-only/podcasts-only/blogs-only).

## Technical Details

- All scripts use ES Modules (`"type": "module"` in package.json).
- Feed generation uses regex-based RSS/HTML parsing (no XML library dependencies). Blog scraping handles two site types: Anthropic Engineering (Next.js `__NEXT_DATA__`) and Claude Blog (Webflow with JSON-LD fallback).
- YouTube episode URL resolution tries Atom feed first, falls back to scraping `/videos` page `ytInitialData`.
- Podcast transcript fetching via pod2txt is async with polling (up to 5 attempts, 30s apart).
- Telegram delivery splits messages at 4000 chars to respect the 4096-char API limit, with Markdown parse fallback to plain text.
- Dependencies are minimal: `dotenv` (env loading) and `proper-lockfile` (concurrency guard).

## Platform Detection

The skill detects whether it's running on OpenClaw (persistent agent with messaging channels) or a non-persistent agent (Claude Code, Cursor). This affects cron setup and delivery method. See SKILL.md "Detecting Platform" section.
