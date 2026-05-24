# pullbotagent

> AI-powered discussion bot for [PullBase](https://pullbase.net) — the decentralized AI model hub on IPFS + Base L2.

Mention `@pullbotagent` in any Discussion or Pull Request comment on a model page and the bot will reply automatically with AI-generated insights, stats, tag suggestions, and more — all rendered as Markdown.

---

## How It Works

```
User posts comment with "@pullbotagent summarize"
          │
          ▼
Express route saves comment → returns 201 instantly
          │
          ▼ (fire-and-forget, no latency for user)
handleBotMention() runs in background
          │
          ├── ensureBotUser()      → upsert bot identity in users table
          ├── parseCommand()       → extract command + args from mention text
          ├── buildResponse()      → query DB / call OpenAI GPT-4o-mini
          └── insert bot comment  → bot reply appears in thread
```

The user gets their comment back **instantly** (201 response). The bot processes and replies asynchronously — no loading spinner, no waiting.

---

## Commands

| Mention | What happens |
|---------|-------------|
| `@pullbotagent help` | Returns a Markdown table of all available commands |
| `@pullbotagent summarize` | AI summary of the model README in 3–5 bullet points |
| `@pullbotagent review` | README quality review with a score /10 and specific improvement suggestions |
| `@pullbotagent tags` | Suggests 5–8 relevant tags based on the model's content and metadata |
| `@pullbotagent stats` | Markdown table: stars, downloads, forks, versions, on-chain status, publish date |
| `@pullbotagent search <query>` | Searches the PullBase model catalogue by name |
| `@pullbotagent compare <model-name>` | Side-by-side AI comparison of two models |
| `@pullbotagent <anything>` | General Q&A — bot answers with the model README as context |

---

## Bot Identity

The bot is registered as a regular user in the database with a deterministic address:

```
Address:  0x000000000000000000000000000000000b07b07b
Username: pullbotagent
```

This address is upserted automatically on every trigger — no manual setup required. Bot comments are identifiable by checking `authorAddress === BOT_ADDRESS` or `authorUsername === "pullbotagent"`.

**Anti-loop protection:** the bot checks `authorAddress !== BOT_ADDRESS` before processing any trigger, so it never responds to its own comments.

---

## Database Schema (Drizzle ORM)

The bot reads from and writes to the following tables:

```ts
// Tables the bot reads
modelsTable           // model metadata + README + stats
modelTagsTable        // tags per model
modelVersionsTable    // version history (used by `stats` command)
discussionCommentsTable  // written to when replying in a discussion
prCommentsTable          // written to when replying in a PR

// Tables used to upsert bot identity
usersTable            // { walletAddress, username }
```

The `discussionsTable` and `pullRequestsTable` `commentCount` field is incremented atomically after each bot reply using a SQL expression update.

---

## Installation

```bash
npm install
```

**Required environment variables:**

```env
DATABASE_URL=postgresql://user:pass@host:5432/pullbase
OPENAI_API_KEY=sk-...
```

See [`.env.example`](.env.example) for the full list.

---

## Integration

### 1. Register the trigger in your Express route

```ts
import { handleBotMention, mentionsBot, BOT_ADDRESS } from "./src/pullbot";

// After saving the comment and sending the 201 response:
router.post("/discussions/:id/comments", async (req, res) => {
  const { authorAddress, body } = req.body;

  const [inserted] = await db.insert(discussionCommentsTable)
    .values({ discussionId: id, authorAddress, body })
    .returning();

  res.status(201).json(inserted); // ← user gets response immediately

  // Fire-and-forget — runs after response is sent
  if (mentionsBot(body) && authorAddress.toLowerCase() !== BOT_ADDRESS.toLowerCase()) {
    void handleBotMention({
      type: "discussion",
      threadId: id,
      modelId: discussion.modelId,
      triggerBody: body,
    });
  }
});
```

### 2. Render bot comments in your frontend

```tsx
const isBot = comment.authorUsername === "pullbotagent";

{isBot ? (
  <span className="badge">🤖 pullbotagent</span>
) : (
  <span>{comment.authorUsername}</span>
)}

{isBot ? (
  <ReactMarkdown>{comment.body}</ReactMarkdown>
) : (
  <p>{comment.body}</p>
)}
```

### 3. Hint in the comment textarea

```tsx
<textarea
  placeholder="Add a comment… (tip: mention @pullbotagent to get AI help)"
/>
```

---

## Adding New Commands

Edit `src/pullbot.ts` and add a new `case` to the `switch` in `buildResponse()`:

```ts
case "benchmark": {
  // fetch benchmark data, call OpenAI, return markdown
  const prompt = `Estimate the inference speed of ${model.name}...`;
  const res = await openai.chat.completions.create({ ... });
  return `## ⚡ Benchmark — ${model.name}\n\n${res.choices[0]?.message?.content}`;
}
```

The `parseCommand()` function automatically extracts the first word after `@pullbotagent` as the command name, so no regex changes are needed.

---

## Project Structure

```
pullbotagent/
├── src/
│   ├── pullbot.ts       # Core bot logic (entry point)
│   └── types.ts         # TypeScript types
├── examples/
│   └── integration.ts   # How to wire the bot into an Express route
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript |
| Database ORM | Drizzle ORM (PostgreSQL) |
| AI | OpenAI GPT-4o-mini (`gpt-4o-mini`) |
| HTTP framework | Express 5 |
| Frontend rendering | React + `react-markdown` |

---

## License

MIT — part of the [PullBase](https://pullbase.net) open-source project.
