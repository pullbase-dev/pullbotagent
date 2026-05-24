/**
 * pullbot.ts — PullBase AI Discussion Bot
 *
 * Responds to @pullbotagent mentions in discussion and pull request comments.
 * Designed to run as a fire-and-forget background task — the user's comment
 * is saved and returned instantly; the bot processes and replies asynchronously.
 *
 * Integration: see /examples/integration.ts
 * Commands:    help | summarize | review | tags | stats | search | compare | <free text>
 */

import { eq, ilike, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import OpenAI from "openai";
import type { BotContext, ParsedCommand } from "./types";

// ---------------------------------------------------------------------------
// Configuration — loaded from environment variables
// ---------------------------------------------------------------------------

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const queryClient = postgres(process.env.DATABASE_URL);
const db = drizzle(queryClient);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// ---------------------------------------------------------------------------
// Bot identity — deterministic address, never changes
// ---------------------------------------------------------------------------

/** Ethereum address used as the bot's identity in the users table. */
export const BOT_ADDRESS = "0x000000000000000000000000000000000b07b07b";

/** Username shown in the UI next to bot comments. */
export const BOT_USERNAME = "pullbotagent";

// ---------------------------------------------------------------------------
// Database schema (inline — adjust column names to match your schema)
// ---------------------------------------------------------------------------

import {
  pgTable, text, integer, serial, boolean, timestamp,
} from "drizzle-orm/pg-core";

const usersTable = pgTable("users", {
  walletAddress: text("wallet_address").primaryKey(),
  username:      text("username").notNull(),
});

const modelsTable = pgTable("models", {
  id:             serial("id").primaryKey(),
  name:           text("name").notNull(),
  slug:           text("slug").notNull(),
  description:    text("description"),
  readme:         text("readme"),
  ownerAddress:   text("owner_address").notNull(),
  task:           text("task").notNull(),
  framework:      text("framework").notNull(),
  license:        text("license").notNull(),
  language:       text("language"),
  parameterCount: text("parameter_count"),
  starCount:      integer("star_count").notNull().default(0),
  downloadCount:  integer("download_count").notNull().default(0),
  forkCount:      integer("fork_count").notNull().default(0),
  isOnChain:      boolean("is_on_chain").notNull().default(false),
  tokenId:        integer("token_id"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const modelTagsTable = pgTable("model_tags", {
  id:      serial("id").primaryKey(),
  modelId: integer("model_id").notNull(),
  tag:     text("tag").notNull(),
});

const modelVersionsTable = pgTable("model_versions", {
  id:        serial("id").primaryKey(),
  modelId:   integer("model_id").notNull(),
  version:   text("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const discussionsTable = pgTable("discussions", {
  id:           serial("id").primaryKey(),
  modelId:      integer("model_id").notNull(),
  authorAddress:text("author_address").notNull(),
  title:        text("title").notNull(),
  body:         text("body").notNull(),
  commentCount: integer("comment_count").notNull().default(0),
  isClosed:     boolean("is_closed").notNull().default(false),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const discussionCommentsTable = pgTable("discussion_comments", {
  id:             serial("id").primaryKey(),
  discussionId:   integer("discussion_id").notNull(),
  authorAddress:  text("author_address").notNull(),
  body:           text("body").notNull(),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const pullRequestsTable = pgTable("pull_requests", {
  id:           serial("id").primaryKey(),
  modelId:      integer("model_id").notNull(),
  authorAddress:text("author_address").notNull(),
  title:        text("title").notNull(),
  body:         text("body"),
  commentCount: integer("comment_count").notNull().default(0),
  status:       text("status").notNull().default("open"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const prCommentsTable = pgTable("pr_comments", {
  id:            serial("id").primaryKey(),
  prId:          integer("pr_id").notNull(),
  authorAddress: text("author_address").notNull(),
  body:          text("body").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Upserts the bot user into the users table.
 * Safe to call on every trigger — uses ON CONFLICT DO NOTHING.
 */
export async function ensureBotUser(): Promise<void> {
  await db
    .insert(usersTable)
    .values({ walletAddress: BOT_ADDRESS, username: BOT_USERNAME })
    .onConflictDoNothing();
}

/**
 * Parses the first word after @pullbotagent as the command name.
 * Everything remaining is treated as arguments.
 *
 * Examples:
 *   "@pullbotagent summarize"           → { command: "summarize", args: "" }
 *   "@pullbotagent compare llama-7b"    → { command: "compare",   args: "llama-7b" }
 *   "@pullbotagent is this model fast?" → { command: "ask",       args: "is this ..." }
 */
function parseCommand(body: string): ParsedCommand {
  const match = body.match(/@pullbotagent\s+([a-z-]+)?(.*)?/i);
  if (!match) return { command: "ask", args: body };
  const command = (match[1] ?? "ask").toLowerCase().trim() || "ask";
  const args    = (match[2] ?? "").trim();
  return { command, args };
}

/**
 * Builds the bot's Markdown reply for a given command.
 * Fetches model data + tags from DB; calls OpenAI for AI-powered commands.
 */
async function buildResponse(
  command: string,
  args: string,
  modelId: number,
  triggerBody: string,
): Promise<string> {
  // Fetch model + tags
  const [model] = await db
    .select()
    .from(modelsTable)
    .where(eq(modelsTable.id, modelId));

  if (!model) return "❌ Model not found.";

  const tagRows = await db
    .select({ tag: modelTagsTable.tag })
    .from(modelTagsTable)
    .where(eq(modelTagsTable.modelId, modelId));
  const tags = tagRows.map((r) => r.tag);

  // Context string injected into AI prompts
  const modelCtx = [
    `**${model.name}**`,
    `Task: ${model.task} | Framework: ${model.framework} | License: ${model.license}`,
    `Language: ${model.language ?? "unspecified"} | Params: ${model.parameterCount ?? "unspecified"}`,
    `Stars: ${model.starCount} | Downloads: ${model.downloadCount} | Forks: ${model.forkCount}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : "Tags: none",
    "",
    "README:",
    (model.readme ?? "No README available.").slice(0, 3000),
  ].join("\n");

  // ── Command dispatch ──────────────────────────────────────────────────────

  switch (command) {
    // ── help ────────────────────────────────────────────────────────────────
    case "help":
      return [
        "## 🤖 PullBot — Available Commands",
        "",
        "| Command | Description |",
        "|---------|-------------|",
        "| `@pullbotagent help` | Show this message |",
        "| `@pullbotagent summarize` | AI summary of this model's README |",
        "| `@pullbotagent review` | README quality review + score /10 |",
        "| `@pullbotagent tags` | Suggest relevant tags |",
        "| `@pullbotagent stats` | Model statistics table |",
        "| `@pullbotagent search <query>` | Search for models by name |",
        "| `@pullbotagent compare <name>` | Compare with another model |",
        "| `@pullbotagent <question>` | Free-form Q&A with model as context |",
        "",
        "_Mention me in any discussion or PR comment to activate._",
      ].join("\n");

    // ── stats ────────────────────────────────────────────────────────────────
    case "stats": {
      const versions = await db
        .select({ id: modelVersionsTable.id })
        .from(modelVersionsTable)
        .where(eq(modelVersionsTable.modelId, modelId));

      return [
        `## 📊 Stats — ${model.name}`,
        "",
        "| Metric | Value |",
        "|--------|-------|",
        `| ⭐ Stars | ${model.starCount} |`,
        `| 📥 Downloads | ${model.downloadCount} |`,
        `| 🔀 Forks | ${model.forkCount} |`,
        `| 📦 Versions | ${versions.length} |`,
        `| 🏷️ Tags | ${tags.length > 0 ? tags.join(", ") : "none"} |`,
        `| 🔗 On-chain | ${model.isOnChain ? `Token #${model.tokenId}` : "Not minted"} |`,
        `| 🗓️ Published | ${model.createdAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} |`,
      ].join("\n");
    }

    // ── search ───────────────────────────────────────────────────────────────
    case "search": {
      if (!args) {
        return "Usage: `@pullbotagent search <query>`\n\nExample: `@pullbotagent search llama text-generation`";
      }
      const results = await db
        .select({
          id:            modelsTable.id,
          name:          modelsTable.name,
          task:          modelsTable.task,
          framework:     modelsTable.framework,
          starCount:     modelsTable.starCount,
          downloadCount: modelsTable.downloadCount,
        })
        .from(modelsTable)
        .where(ilike(modelsTable.name, `%${args}%`))
        .limit(6);

      if (results.length === 0) return `🔍 No models found for **"${args}"**.`;

      const rows = results
        .map((r) => `- **${r.name}** — ${r.task} / ${r.framework} ⭐ ${r.starCount} 📥 ${r.downloadCount}`)
        .join("\n");

      return `## 🔍 Search: "${args}"\n\n${rows}`;
    }

    // ── compare ──────────────────────────────────────────────────────────────
    case "compare": {
      if (!args) return "Usage: `@pullbotagent compare <model-name>`";

      const [other] = await db
        .select()
        .from(modelsTable)
        .where(ilike(modelsTable.name, `%${args}%`))
        .limit(1);

      if (!other) {
        return `❌ No model matching **"${args}"**. Try: \`@pullbotagent search ${args}\``;
      }

      const otherTagRows = await db
        .select({ tag: modelTagsTable.tag })
        .from(modelTagsTable)
        .where(eq(modelTagsTable.modelId, other.id));
      const otherTags = otherTagRows.map((r) => r.tag);

      const prompt = `You are PullBot, a technical assistant on PullBase (decentralized AI model hub on IPFS + Base L2).
Compare these two models objectively and concisely in markdown. Use a table for side-by-side stats.

Model A: ${model.name}
- Task: ${model.task}, Framework: ${model.framework}, License: ${model.license}
- Stars: ${model.starCount}, Downloads: ${model.downloadCount}, Forks: ${model.forkCount}
- Tags: ${tags.join(", ")}
- README excerpt: ${(model.readme ?? "").slice(0, 800)}

Model B: ${other.name}
- Task: ${other.task}, Framework: ${other.framework}, License: ${other.license}
- Stars: ${other.starCount}, Downloads: ${other.downloadCount}, Forks: ${other.forkCount}
- Tags: ${otherTags.join(", ")}
- README excerpt: ${(other.readme ?? "").slice(0, 800)}

Provide: similarities, key differences, and a short recommendation on which to use and when.`;

      const res = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 600,
      });

      const content = res.choices[0]?.message?.content ?? "Could not generate comparison.";
      return `## ⚖️ ${model.name} vs ${other.name}\n\n${content}`;
    }

    // ── summarize ────────────────────────────────────────────────────────────
    case "summarize": {
      const prompt = `You are PullBot on PullBase (decentralized AI model hub).
Summarize this model in 3–5 bullet points for a developer audience. Be precise and technical, no fluff.

${modelCtx}`;

      const res = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 400,
      });

      const content = res.choices[0]?.message?.content ?? "Could not generate summary.";
      return `## 📝 Summary — ${model.name}\n\n${content}`;
    }

    // ── review ───────────────────────────────────────────────────────────────
    case "review": {
      const prompt = `You are PullBot, a technical reviewer on PullBase.
Review this model's README and metadata quality. Be concise and specific.

Cover:
1. What is done well (max 2 points)
2. What is missing or unclear (be specific — e.g. "no usage example", "missing license section")
3. Score X/10 with a one-line justification

${modelCtx}`;

      const res = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 500,
      });

      const content = res.choices[0]?.message?.content ?? "Could not generate review.";
      return `## 🔍 README Review — ${model.name}\n\n${content}`;
    }

    // ── tags ─────────────────────────────────────────────────────────────────
    case "tags": {
      const prompt = `You are PullBot on PullBase. Suggest 5–8 relevant tags for this model.
Output ONLY a comma-separated list of lowercase tags, nothing else.
Tags should reflect: task type, architecture, domain, language, framework quirks.

${modelCtx}`;

      const res = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 80,
      });

      const suggested = (res.choices[0]?.message?.content ?? "").trim();
      const tagList   = suggested.split(",").map((t) => t.trim()).filter(Boolean);
      const formatted = tagList.map((t) => `\`${t}\``).join("  ");

      return `## 🏷️ Suggested Tags — ${model.name}\n\n${formatted}\n\n_Add them from the model settings page._`;
    }

    // ── default: free-form Q&A ───────────────────────────────────────────────
    default: {
      const prompt = `You are PullBot, an AI assistant on PullBase (decentralized AI model hub on IPFS + Base L2).
A user mentioned you in a discussion about model "${model.name}". Answer their question helpfully and concisely in markdown.

Model context:
${modelCtx}

User message: ${triggerBody}`;

      const res = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 500,
      });

      return (
        res.choices[0]?.message?.content ??
        "I couldn't process that. Try `@pullbotagent help` to see available commands."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the comment body contains a @pullbotagent mention.
 * Call this before invoking handleBotMention() to avoid unnecessary work.
 */
export function mentionsBot(text: string): boolean {
  return /@pullbotagent/i.test(text);
}

/**
 * Main entry point — call this after saving the user's comment (fire-and-forget).
 *
 * ```ts
 * void handleBotMention({ type: "discussion", threadId: id, modelId, triggerBody: body });
 * ```
 *
 * The function catches all errors internally and logs them — it never throws,
 * so it is safe to call without await.
 */
export async function handleBotMention(context: BotContext): Promise<void> {
  try {
    await ensureBotUser();

    const { command, args } = parseCommand(context.triggerBody);
    const responseBody      = await buildResponse(command, args, context.modelId, context.triggerBody);

    if (context.type === "discussion") {
      await db.insert(discussionCommentsTable).values({
        discussionId:  context.threadId,
        authorAddress: BOT_ADDRESS,
        body:          responseBody,
      });
      await db
        .update(discussionsTable)
        .set({ commentCount: sql`${discussionsTable.commentCount} + 1` })
        .where(eq(discussionsTable.id, context.threadId));
    } else {
      await db.insert(prCommentsTable).values({
        prId:          context.threadId,
        authorAddress: BOT_ADDRESS,
        body:          responseBody,
      });
      await db
        .update(pullRequestsTable)
        .set({ commentCount: sql`${pullRequestsTable.commentCount} + 1` })
        .where(eq(pullRequestsTable.id, context.threadId));
    }
  } catch (err) {
    console.error("[PullBot] Error handling mention:", err);
  }
}
