/**
 * examples/integration.ts
 *
 * Shows how to wire pullbotagent into an Express 5 route.
 * The key pattern: save the comment → send 201 response → trigger bot (void, no await).
 */

import { Router } from "express";
import { handleBotMention, mentionsBot, BOT_ADDRESS } from "../src/pullbot";

// Assume you have a `db` instance and relevant schema tables imported.
// Adjust imports to match your project structure.

const router = Router();

// POST /discussions/:id/comments
router.post("/discussions/:id/comments", async (req, res) => {
  const threadId = Number(req.params.id);
  const { authorAddress, body } = req.body as { authorAddress: string; body: string };

  if (!authorAddress || !body) {
    res.status(400).json({ error: "authorAddress and body are required" });
    return;
  }

  // 1. Fetch the discussion to get the modelId
  const [discussion] = await db
    .select({ id: discussionsTable.id, modelId: discussionsTable.modelId })
    .from(discussionsTable)
    .where(eq(discussionsTable.id, threadId));

  if (!discussion) {
    res.status(404).json({ error: "Discussion not found" });
    return;
  }

  // 2. Save the user's comment
  const [inserted] = await db
    .insert(discussionCommentsTable)
    .values({ discussionId: threadId, authorAddress, body })
    .returning();

  // 3. Increment comment count
  await db
    .update(discussionsTable)
    .set({ commentCount: sql`${discussionsTable.commentCount} + 1` })
    .where(eq(discussionsTable.id, threadId));

  // 4. Return the saved comment immediately — user gets a fast response
  res.status(201).json(inserted);

  // 5. Trigger bot in background (fire-and-forget, no await)
  //    Anti-loop: skip if the comment was posted by the bot itself.
  if (mentionsBot(body) && authorAddress.toLowerCase() !== BOT_ADDRESS.toLowerCase()) {
    void handleBotMention({
      type:        "discussion",
      threadId,
      modelId:     discussion.modelId,
      triggerBody: body,
    });
  }
});

// The same pattern applies for PR comments — just use prCommentsTable and type: "pr"
router.post("/pull-requests/:id/comments", async (req, res) => {
  const threadId = Number(req.params.id);
  const { authorAddress, body } = req.body as { authorAddress: string; body: string };

  const [pr] = await db
    .select({ id: pullRequestsTable.id, modelId: pullRequestsTable.modelId })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, threadId));

  if (!pr) { res.status(404).json({ error: "PR not found" }); return; }

  const [inserted] = await db
    .insert(prCommentsTable)
    .values({ prId: threadId, authorAddress, body })
    .returning();

  await db
    .update(pullRequestsTable)
    .set({ commentCount: sql`${pullRequestsTable.commentCount} + 1` })
    .where(eq(pullRequestsTable.id, threadId));

  res.status(201).json(inserted);

  if (mentionsBot(body) && authorAddress.toLowerCase() !== BOT_ADDRESS.toLowerCase()) {
    void handleBotMention({
      type:        "pr",
      threadId,
      modelId:     pr.modelId,
      triggerBody: body,
    });
  }
});

export default router;
