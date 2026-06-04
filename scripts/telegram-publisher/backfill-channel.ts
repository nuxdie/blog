import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

type Lang = "en" | "ru";

interface TelegramMessage {
  message_id: number;
}

interface TelegramChatInfo {
  username?: string;
  title?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface PostRecord {
  filePath: string;
  relativePath: string;
  lang: Lang;
  slug: string;
  pubDate: string;
  title: string;
  description: string;
  telegramPostUrl: string;
}

interface BackfillEntry {
  telegramPostUrl: string;
  messageId: number;
  createdAt: string;
}

interface BackfillState {
  version: 1;
  channelUsername: string;
  entries: Record<string, BackfillEntry>;
}

interface Args {
  dryRun: boolean;
  delayMs: number;
  limit: number | null;
  resetState: boolean;
}

const repoDir = process.cwd();

const config = {
  telegramToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
  publicChannelChatId: requiredEnv("PUBLIC_CHANNEL_CHAT_ID"),
  publicChannelUsername: normalizeTelegramUsername(process.env.PUBLIC_CHANNEL_USERNAME ?? ""),
  publicChannelDisableNotification: parseBooleanEnv(process.env.PUBLIC_CHANNEL_DISABLE_NOTIFICATION, true),
  publicSiteUrl: normalizeSiteBaseUrl(process.env.PUBLIC_SITE_URL ?? ""),
  githubRepo: normalizeGitHubRepo(process.env.GITHUB_REPO ?? ""),
  botDataDir: process.env.BOT_DATA_DIR?.trim() || path.join(repoDir, "publisher-data")
};

const args = parseArgs(process.argv.slice(2));
const stateFilePath = path.join(config.botDataDir, "backfill-telegram-comments-state.json");

async function main() {
  await mkdir(config.botDataDir, { recursive: true });

  if (args.resetState) {
    await writeFile(stateFilePath, JSON.stringify({ version: 1, channelUsername: "", entries: {} }, null, 2) + "\n", "utf8");
  }

  const channelUsername = await resolvePublicChannelUsername();
  const siteBaseUrl = await resolveSiteBaseUrl();
  const state = await loadState(channelUsername);
  const posts = await collectPosts();

  const candidates = posts.filter((post) => !post.telegramPostUrl);
  const pending = candidates.filter((post) => !state.entries[post.relativePath]);
  const recoverable = candidates.filter((post) => Boolean(state.entries[post.relativePath]));

  console.log(`Posts total: ${posts.length}`);
  console.log(`Posts already linked: ${posts.length - candidates.length}`);
  console.log(`Backfill candidates: ${candidates.length}`);
  console.log(`Recovered from state: ${recoverable.length}`);
  console.log(`New channel posts needed: ${pending.length}`);
  console.log(`Dry run: ${args.dryRun ? "yes" : "no"}`);
  console.log(`Channel: @${channelUsername}`);
  console.log(`Site base: ${siteBaseUrl}`);

  let processed = 0;

  for (const post of candidates) {
    if (args.limit != null && processed >= args.limit) {
      break;
    }

    const existing = state.entries[post.relativePath];
    if (existing) {
      if (args.dryRun) {
        console.log(`[dry] restore ${post.relativePath} <- ${existing.telegramPostUrl}`);
      } else {
        await upsertFrontmatterStringField(post.filePath, "telegramPostUrl", existing.telegramPostUrl);
        console.log(`restored ${post.relativePath}`);
      }
      processed += 1;
      continue;
    }

    const postUrl = `${siteBaseUrl}/${post.lang}/blog/${post.slug}/`;
    const messageText = formatChannelText(post, postUrl);

    if (args.dryRun) {
      console.log(`[dry] post ${post.relativePath}`);
      processed += 1;
      continue;
    }

    const sent = await sendTelegramMessage(config.publicChannelChatId, messageText, {
      disableNotification: config.publicChannelDisableNotification,
      disableWebPagePreview: false
    });

    const telegramPostUrl = `https://t.me/${channelUsername}/${sent.message_id}`;
    state.entries[post.relativePath] = {
      telegramPostUrl,
      messageId: sent.message_id,
      createdAt: new Date().toISOString()
    };
    await saveState(state);

    await upsertFrontmatterStringField(post.filePath, "telegramPostUrl", telegramPostUrl);
    console.log(`linked ${post.relativePath} -> ${telegramPostUrl}`);

    processed += 1;
    await sleep(args.delayMs);
  }

  console.log(`Done. Processed: ${processed}`);
}

async function collectPosts(): Promise<PostRecord[]> {
  const dirs: Array<{ lang: Lang; dirPath: string }> = [
    { lang: "en", dirPath: path.join(repoDir, "src", "pages", "en", "blog") },
    { lang: "ru", dirPath: path.join(repoDir, "src", "pages", "ru", "blog") }
  ];

  const records: PostRecord[] = [];

  for (const { lang, dirPath } of dirs) {
    const names = await readdir(dirPath);
    for (const fileName of names) {
      if (!fileName.endsWith(".md")) {
        continue;
      }

      const filePath = path.join(dirPath, fileName);
      const relativePath = path.relative(repoDir, filePath).split(path.sep).join(path.posix.sep);
      const source = await readFile(filePath, "utf8");
      const frontmatter = parseFrontmatter(source);
      const slug = fileName.slice(0, -3);

      records.push({
        filePath,
        relativePath,
        lang,
        slug,
        pubDate: frontmatter.pubDate,
        title: frontmatter.title,
        description: frontmatter.description,
        telegramPostUrl: frontmatter.telegramPostUrl
      });
    }
  }

  records.sort((a, b) => {
    const dateDiff = a.pubDate.localeCompare(b.pubDate);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  return records;
}

function parseFrontmatter(source: string): {
  title: string;
  description: string;
  pubDate: string;
  telegramPostUrl: string;
} {
  const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error("Missing YAML frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const title = readYamlString(frontmatter, "title");
  const description = readYamlString(frontmatter, "description");
  const pubDate = readYamlScalar(frontmatter, "pubDate");
  const telegramPostUrl = readYamlString(frontmatter, "telegramPostUrl", false);

  if (!title || !description || !pubDate) {
    throw new Error("Frontmatter missing title/description/pubDate");
  }

  return {
    title,
    description,
    pubDate,
    telegramPostUrl
  };
}

function readYamlScalar(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  if (!match) {
    return "";
  }
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function readYamlString(frontmatter: string, key: string, required = true): string {
  const raw = readYamlScalar(frontmatter, key);
  if (!raw && required) {
    throw new Error(`Missing frontmatter field: ${key}`);
  }
  return raw;
}

function formatChannelText(post: PostRecord, postUrl: string): string {
  const lines = [post.title, "", post.description, "", `Read: ${postUrl}`];
  return truncate(lines.join("\n"), 3900);
}

async function upsertFrontmatterStringField(filePath: string, fieldName: string, value: string) {
  const source = await readFile(filePath, "utf8");
  const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error(`Could not find YAML frontmatter in ${filePath}`);
  }

  const frontmatter = frontmatterMatch[1];
  const escapedFieldName = escapeRegExp(fieldName);
  const fieldPattern = new RegExp(`^${escapedFieldName}:\\s*.*$`, "m");
  const rendered = `${fieldName}: "${escapeYamlString(value)}"`;

  const updatedFrontmatter = fieldPattern.test(frontmatter)
    ? frontmatter.replace(fieldPattern, rendered)
    : `${frontmatter}\n${rendered}`;

  const updated = source.replace(/^---\n[\s\S]*?\n---\n/, `---\n${updatedFrontmatter}\n---\n`);
  await writeFile(filePath, updated, "utf8");
}

async function loadState(channelUsername: string): Promise<BackfillState> {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BackfillState>;
    return {
      version: 1,
      channelUsername,
      entries: parsed.entries ?? {}
    };
  } catch {
    return {
      version: 1,
      channelUsername,
      entries: {}
    };
  }
}

async function saveState(state: BackfillState) {
  await writeFile(stateFilePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function resolvePublicChannelUsername(): Promise<string> {
  if (config.publicChannelUsername) {
    return config.publicChannelUsername;
  }

  const chat = await telegramRequest<TelegramChatInfo>("getChat", {
    chat_id: config.publicChannelChatId
  });

  const username = normalizeTelegramUsername(chat.username ?? "");
  if (!username) {
    const title = chat.title ? ` (${chat.title})` : "";
    throw new Error(`PUBLIC_CHANNEL_CHAT_ID must resolve to a public channel with @username${title}`);
  }

  return username;
}

async function resolveSiteBaseUrl(): Promise<string> {
  if (config.publicSiteUrl) {
    return config.publicSiteUrl;
  }

  const cnamePath = path.join(repoDir, "public", "CNAME");
  try {
    const cname = (await readFile(cnamePath, "utf8")).trim();
    if (cname) {
      return `https://${cname}`;
    }
  } catch {
    // fall through
  }

  const [owner, repo] = config.githubRepo.split("/");
  if (owner && repo) {
    return `https://${owner}.github.io/${repo}`;
  }

  throw new Error("Cannot resolve site base URL. Set PUBLIC_SITE_URL or GITHUB_REPO.");
}

async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options?: { disableWebPagePreview?: boolean; disableNotification?: boolean }
): Promise<TelegramMessage> {
  return telegramRequest<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: options?.disableWebPagePreview ?? false,
    disable_notification: options?.disableNotification ?? true
  });
}

async function telegramRequest<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  const parsed = safeParseJson(raw) as TelegramApiResponse<T> | null;

  if (!response.ok) {
    const detail = parsed?.description || raw || "no response body";
    throw new Error(`Telegram API ${method} failed (${response.status}): ${detail}`);
  }

  if (!parsed || !parsed.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }

  return parsed.result;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let delayMs = 1200;
  let limit: number | null = null;
  let resetState = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--reset-state") {
      resetState = true;
      continue;
    }

    if (token === "--delay-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--delay-ms must be a non-negative number");
      }
      delayMs = value;
      i += 1;
      continue;
    }

    if (token === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      limit = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    dryRun,
    delayMs,
    limit,
    resetState
  };
}

function normalizeTelegramUsername(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const noPrefix = trimmed
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^t\.me\//i, "")
    .replace(/^@+/, "")
    .replace(/\/.*/, "");

  if (!/^[a-zA-Z0-9_]{5,}$/.test(noPrefix)) {
    return "";
  }

  return noPrefix;
}

function normalizeSiteBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const prefixed = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(prefixed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeGitHubRepo(input: string): string {
  const trimmed = input.trim();
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  const httpsMatch = withoutGitSuffix.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  const sshMatch = withoutGitSuffix.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (sshMatch) {
    return sshMatch[1];
  }

  return withoutGitSuffix;
}

function parseBooleanEnv(input: string | undefined, defaultValue: boolean): boolean {
  if (input == null) {
    return defaultValue;
  }

  const value = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return defaultValue;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function truncate(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }
  return `${input.slice(0, limit - 1).trimEnd()}...`;
}

function escapeYamlString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
