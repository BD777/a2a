import { parseAgentOutput } from '../protocol/agent-output.js';
import { readEnvProfile } from './env-profile.js';

export class ClaudeAgentRuntime {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  async runTurn({ bot, prompt, state, signal, stream }) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const options = {
      cwd: bot.workingDir || this.config.projectDir,
      permissionMode: this.config.claude.permissionMode,
      effort: this.config.claude.effort,
      env: {
        ...process.env,
        ...readEnvProfile(this.config.claude.profilePath),
      },
    };
    if (this.config.claude.model) options.model = this.config.claude.model;
    if (this.config.claude.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.config.claude.pathToClaudeCodeExecutable;
    }
    if (state.threadId) options.resume = state.threadId;
    if (this.config.claude.toolsMode === 'none') options.tools = [];
    if (stream) options.includePartialMessages = true;

    let resultMessage = null;
    let sessionId = state.threadId || '';
    const seenToolUses = new Set();
    const seenToolResults = new Set();
    const conversation = query({ prompt, options });
    const abort = () => conversation.close();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const message of conversation) {
        if (message?.session_id) sessionId = message.session_id;
        if (message?.type === 'result') resultMessage = message;
        if (!stream) continue;
        if (message?.type === 'stream_event') {
          const inner = message.event;
          if (inner?.type === 'content_block_delta') {
            const delta = inner.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              stream.appendText(delta.text);
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              stream.appendThinking(delta.thinking);
            }
          }
        } else if (message?.type === 'assistant') {
          // Fallback path: if the relay buffers SSE so `stream_event` deltas never
          // arrive, the SDK still emits `assistant` messages carrying the full
          // content blocks. setText/setThinking are idempotent against the delta
          // path (same final string), so this is safe to run unconditionally.
          const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
          let textBuffer = '';
          let thinkingBuffer = '';
          for (const block of blocks) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              textBuffer += block.text;
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
              thinkingBuffer += block.thinking;
            } else if (block?.type === 'tool_use') {
              const key = block.id || stableToolUseKey(block);
              if (!seenToolUses.has(key)) {
                seenToolUses.add(key);
                stream.appendActivity(formatClaudeToolUse(block));
              }
            }
          }
          if (textBuffer) stream.setText(textBuffer);
          if (thinkingBuffer) stream.setThinking(thinkingBuffer);
        } else if (message?.type === 'user') {
          const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
          for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const key = block.tool_use_id || stableToolResultKey(block);
            if (seenToolResults.has(key)) continue;
            seenToolResults.add(key);
            stream.appendActivity(formatClaudeToolResult(block));
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (!resultMessage) throw new Error('Claude Agent SDK finished without a result message');
    const output = parseAgentOutput(resultMessage.structured_output ?? resultMessage.result);
    return {
      ...output,
      provider: 'claude-agent-sdk',
      threadId: sessionId,
      usage: resultMessage.usage || null,
    };
  }
}

function formatClaudeToolUse(block) {
  const name = block.name || 'tool';
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (name === 'Bash' && input.command) {
    return `- Running Bash: ${inlineCode(input.command, 160)}`;
  }
  if (name === 'Skill' && input.skill) {
    return `- Running Skill: ${inlineCode(input.skill, 80)}`;
  }
  if (name === 'Read' && input.file_path) {
    return `- Running Read: ${inlineCode(input.file_path, 140)}`;
  }
  if (name === 'TaskOutput' && input.task_id) {
    return `- Running TaskOutput: ${inlineCode(input.task_id, 80)}`;
  }
  const detail = summarizeInput(input);
  return detail ? `- Running ${name}: ${detail}` : `- Running ${name}`;
}

function formatClaudeToolResult(block) {
  const prefix = block.is_error ? '- Tool error:' : '- Tool result:';
  const summary = summarizeToolContent(block.content);
  return summary ? `${prefix} ${summary}` : prefix;
}

function summarizeInput(input) {
  const entries = Object.entries(input || {}).slice(0, 3);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `${key}=${truncateOneLine(formatInputValue(value), 60)}`)
    .join(', ');
}

function summarizeToolContent(content) {
  if (typeof content === 'string') return truncateOneLine(firstUsefulLine(content), 180);
  if (Array.isArray(content)) {
    const text = content
      .map((item) => item?.text || item?.content || '')
      .filter(Boolean)
      .join(' ');
    return truncateOneLine(firstUsefulLine(text), 180);
  }
  if (content && typeof content === 'object') {
    return truncateOneLine(JSON.stringify(content), 180);
  }
  return '';
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function stableToolResultKey(block) {
  return `${block.is_error ? 'err' : 'ok'}:${summarizeToolContent(block.content)}`;
}

function stableToolUseKey(block) {
  return `${block.name || 'tool'}:${JSON.stringify(block.input || {})}`;
}

function formatInputValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inlineCode(text, max) {
  return `\`${truncateOneLine(text, max).replace(/`/g, "'")}\``;
}

function truncateOneLine(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
