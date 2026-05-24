/**
 * BotContext — passed to handleBotMention() when a mention is detected.
 */
export interface BotContext {
  /** Whether the mention occurred in a discussion thread or a pull request. */
  type: "discussion" | "pr";

  /** Database ID of the discussion or PR where the mention occurred. */
  threadId: number;

  /**
   * Database ID of the model that the discussion/PR belongs to.
   * Used to fetch model metadata and README for AI context.
   */
  modelId: number;

  /** The full body text of the comment that triggered the bot. */
  triggerBody: string;
}

/**
 * ParsedCommand — result of parseCommand().
 */
export interface ParsedCommand {
  /** Lowercase command word extracted from the mention (e.g. "summarize", "stats"). */
  command: string;

  /** Everything after the command word (e.g. "llama" in "@pullbotagent compare llama"). */
  args: string;
}
