# Tsatsin

Tech explorations exported from Telegram to the web.

## Run locally

```bash
bun install
bun run dev
```

Note: full-text search index is generated only on production build (`bun run build`). Use `bun run preview` to test search locally.

## Write a post

English posts live in `src/pages/en/blog/`.

```md
---
layout: ../../../layouts/PostLayout.astro
title: "Thread Title"
description: "Auto-generated from first sentence."
pubDate: 2026-02-24
lang: en
messageCount: 37
telegramPostUrl: "https://t.me/your_channel/123" # optional, enables comments widget
# tags are optional; build auto-generates tags when omitted
# tags:
#   - ai
#   - llm
---

Your content here.
```

Russian posts live in `src/pages/ru/blog/`:

```md
---
layout: ../../../layouts/PostLayout.astro
title: "Заголовок треда"
description: "Автогенерация из первого предложения."
pubDate: 2026-02-24
lang: ru
messageCount: 37
telegramPostUrl: "https://t.me/your_channel/123" # optional, enables comments widget
# tags are optional; build auto-generates tags when omitted
# tags:
#   - ai
#   - llm
---

Ваш текст.
```

`messageCount` shows how many messages in the thread.

## Add images to posts

1. Put image files in `public/images/`.
2. Reference them from Markdown with an absolute path.

```md
![Screenshot of release dashboard](/images/release-dashboard.webp)
```

Optional caption:

```html
<figure>
  <img src="/images/release-dashboard.webp" alt="Screenshot of release dashboard" />
  <figcaption>Post release status from Friday deploy.</figcaption>
</figure>
```

## Language routes and feeds

- English: `/en/`
- Russian: `/ru/`
- All posts RSS: `/rss.xml`
- English RSS: `/en/rss.xml`
- Russian RSS: `/ru/rss.xml`

Search routes:

- Global: `/search/`
- English only: `/en/search/`
- Russian only: `/ru/search/`

Calendar routes:

- Global: `/calendar/`
- English only: `/en/calendar/`
- Russian only: `/ru/calendar/`

Tag routes:

- Global tags: `/tags/`
- English tags: `/en/tags/`
- Russian tags: `/ru/tags/`

Build generates a full-text Pagefind index into `dist/pagefind/`.

Tagging is automatic during build: posts get deterministic tags from title/description/content hints (plus media/link signals). If needed, you can still set `tags` manually in frontmatter using the fixed tag vocabulary.

## Telegram publisher bot (Telegram → PR)

Private bot that forwards thread messages into PRs.

Flow:

1. Write in Telegram Saved Messages.
2. Forward the full thread to your bot (text + media + files in order).
3. Send `/publish`, then pick publish date (`first`, `today`, or `YYYY-MM-DD`).
4. Bot creates a branch and opens a PR to `main`.
5. If you published by mistake, reply `delete` to that publish summary message.

Behavior:

- Keeps forwarded message order.
- Uses original forwarded message date for `pubDate` (first message in thread).
- Detects language automatically (`en` or `ru`).
- Infers title, description, and slug.
- Saves media to `public/images/<slug>/`.
- Writes post file to `src/pages/en/blog/` or `src/pages/ru/blog/`.
- Imports Telegram documents (ZIP, PDF, etc.) to `public/files/<slug>/` when possible.
- If a file cannot be downloaded, keeps an attachment placeholder in the post instead of skipping it.
- Adds up to 4 `previewImages` for thread cards.
- Imports native Telegram videos (with captions) and saves them to `public/videos/<slug>/`.
- Adds `previewVideos` for video thread cards.
- Adds `youtubeVideoIds` for one-message YouTube thread cards.
- Adds `singleMessageHtml` for one-message threads (used as inline card content).
- Optional public-channel flow: pre-posts to Telegram channel, writes `telegramPostUrl` to frontmatter, then edits channel post after merge.
- Preserves Telegram formatting (italic, bold, code, links, code blocks).
- Auto-embeds YouTube links from text messages.
- Auto-merges bot-opened PRs when mergeable and checks are green.
- Sends clear publish outcome in Telegram (merged vs waiting) and the final post URL.
- Supports revert by reply: `delete` on a publish summary closes open PRs, or opens a cleanup PR for merged posts.

Supported bot commands:

- `/start` - usage help
- `/status` - current draft counts
- `/publish` - choose publish date and publish draft as PR
- `/cancel` - cancel pending publish date prompt
- `/reset` - clear draft buffer

Additional action (reply-based):

- reply `delete` to a bot publish summary message to remove mistaken publications

The bot registers these commands in Telegram automatically, so they appear in the command menu.

Auto-finalize:

- If `AUTO_FINALIZE_MINUTES` is greater than `0`, draft auto-publishes after inactivity timeout.
- Retry delay after failures is controlled by `AUTO_FINALIZE_RETRY_MINUTES`.

Startup self-checks:

- Validates Telegram bot token (`getMe`).
- Validates GitHub repo access + base branch.
- Checks token permissions where available (`pull` + `push`).
- Verifies working tree is clean before bot starts.

### Run bot locally

```bash
cp .env.publisher.example .env.publisher
bun run tg:bot
```

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`
- `GITHUB_TOKEN`
- `GITHUB_REPO` (example: `nuxdie/blog`)

Optional variables:

- `PUBLISH_REPO_DIR` (default: `/repo`)
- `BOT_DATA_DIR` (default: `/data`)
- `POST_BASE_BRANCH` (default: `main`)
- `POLL_TIMEOUT_SECONDS` (default: `50`)
- `AUTO_FINALIZE_MINUTES` (default: `0` = disabled)
- `AUTO_FINALIZE_RETRY_MINUTES` (default: `30`)
- `AUTO_MERGE_BOT_PRS` (default: `true`)
- `AUTO_MERGE_WAIT_SECONDS` (default: `300`)
- `AUTO_MERGE_POLL_SECONDS` (default: `5`)
- `AUTO_MERGE_METHOD` (default: `squash`, options: `merge`, `squash`, `rebase`)
- `PUBLIC_CHANNEL_ENABLED` (default: `false`)
- `PUBLIC_CHANNEL_CHAT_ID` (required when `PUBLIC_CHANNEL_ENABLED=true`, e.g. `@your_channel`)
- `PUBLIC_CHANNEL_USERNAME` (optional override for t.me link generation)
- `PUBLIC_CHANNEL_DISABLE_NOTIFICATION` (default: `true`)
- `PUBLIC_SITE_URL` (optional explicit base URL used in bot publish messages)

### One-off backfill for old posts (Telegram comments)

If you already have old posts without `telegramPostUrl`, run a one-off backfill.

The script will:

- scan `src/pages/en/blog/*.md` and `src/pages/ru/blog/*.md`
- skip posts that already have `telegramPostUrl`
- publish each missing post to your public Telegram channel
- write `telegramPostUrl` into frontmatter for each post
- keep checkpoint state in `publisher-data/backfill-telegram-comments-state.json` for safe resume

Run dry-run first:

```bash
bun run tg:backfill-comments --dry-run
```

Then run full backfill:

```bash
bun run tg:backfill-comments
```

Useful flags:

- `--limit 10` - process first N missing posts
- `--delay-ms 1500` - delay between Telegram posts (default `1200`)
- `--reset-state` - clear checkpoint state and start from scratch

### Run bot on home server (Docker)

```bash
cp .env.publisher.example .env.publisher
docker compose -f docker-compose.publisher.yml up -d --build
```

If the GitHub account/repo is renamed, update `GITHUB_REPO` in `.env.publisher` and the mounted repo remote:

```bash
git -C publisher-repo-live remote set-url origin https://github.com/nuxdie/blog.git
```

The compose file mounts:

- repo at `/repo` (for git branch/commit/push)
- persistent state at `./publisher-data` (draft buffer + update offset)

## Deploy

1. Push this repository to GitHub.
2. In GitHub repo settings, set **Pages** source to **GitHub Actions**.
3. Push to `main` and the workflow in `.github/workflows/deploy.yml` will publish the site.

This project uses Bun for local development and CI builds.

Custom domain is set by `public/CNAME`:

`blog.tsatsin.com`
