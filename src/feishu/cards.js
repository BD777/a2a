const DEFAULT_AGENT_TEMPLATE = 'indigo';
const DEFAULT_SYSTEM_TEMPLATES = {
  info: 'grey',
  warn: 'yellow',
  error: 'red',
};

const STREAMING_HEADER_TEMPLATE = 'yellow';
const FAILED_HEADER_TEMPLATE = 'red';

export function buildAgentCard({ cliId, round, content, partIndex, partCount, template }) {
  const headerTemplate = template || DEFAULT_AGENT_TEMPLATE;
  const partSuffix = partCount > 1 ? ` · part ${partIndex}/${partCount}` : '';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate,
      title: { tag: 'plain_text', content: `${cliId} · round ${round}${partSuffix}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: content || '' },
      ],
    },
  };
}

export function buildSystemCard({ text, level = 'info', partIndex, partCount, templates }) {
  const map = { ...DEFAULT_SYSTEM_TEMPLATES, ...(templates || {}) };
  const template = map[level] || DEFAULT_SYSTEM_TEMPLATES.info;
  const partSuffix = partCount > 1 ? ` · part ${partIndex}/${partCount}` : '';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `A2A system${partSuffix}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: text || '' },
      ],
    },
  };
}

export const STREAMING_BODY_ELEMENT_ID = 'a2a_body';
export const STREAMING_THINKING_PANEL_ID = 'a2a_thinking_panel';
export const STREAMING_THINKING_ELEMENT_ID = 'a2a_thinking_md';

export function buildStreamingAgentCard({ cliId, round }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, streaming_mode: true },
    header: {
      template: STREAMING_HEADER_TEMPLATE,
      title: { tag: 'plain_text', content: `${cliId} · round ${round} · ⏳ streaming…` },
    },
    body: {
      elements: [
        {
          tag: 'collapsible_panel',
          element_id: STREAMING_THINKING_PANEL_ID,
          expanded: true,
          header: { title: { tag: 'markdown', content: '💭 thinking' } },
          elements: [
            { tag: 'markdown', element_id: STREAMING_THINKING_ELEMENT_ID, content: '_Waiting for reasoning or tool output..._' },
          ],
        },
        { tag: 'markdown', element_id: STREAMING_BODY_ELEMENT_ID, content: '_Starting turn. Waiting for the first tokens..._' },
      ],
    },
  };
}

export function buildFinalAgentCard({
  cliId,
  round,
  content,
  thinking,
  partIndex,
  partCount,
  template,
}) {
  const headerTemplate = template || DEFAULT_AGENT_TEMPLATE;
  const partSuffix = partCount > 1 ? ` · part ${partIndex}/${partCount}` : '';
  const elements = [];
  if (thinking) {
    elements.push({
      tag: 'collapsible_panel',
      element_id: STREAMING_THINKING_PANEL_ID,
      expanded: false,
      header: { title: { tag: 'markdown', content: '💭 thinking' } },
      elements: [
        { tag: 'markdown', element_id: STREAMING_THINKING_ELEMENT_ID, content: thinking },
      ],
    });
  }
  elements.push({ tag: 'markdown', element_id: STREAMING_BODY_ELEMENT_ID, content: content || '' });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate,
      title: { tag: 'plain_text', content: `${cliId} · round ${round}${partSuffix}` },
    },
    body: { elements },
  };
}

export function buildFailedAgentCard({ cliId, round, content, thinking, errorMessage }) {
  const elements = [];
  if (thinking) {
    elements.push({
      tag: 'collapsible_panel',
      element_id: STREAMING_THINKING_PANEL_ID,
      expanded: false,
      header: { title: { tag: 'markdown', content: '💭 thinking' } },
      elements: [
        { tag: 'markdown', element_id: STREAMING_THINKING_ELEMENT_ID, content: thinking },
      ],
    });
  }
  elements.push({
    tag: 'markdown',
    element_id: STREAMING_BODY_ELEMENT_ID,
    content: content || '_(no output before failure)_',
  });
  elements.push({
    tag: 'markdown',
    content: `⚠ **${errorMessage || 'turn failed'}**`,
  });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: FAILED_HEADER_TEMPLATE,
      title: { tag: 'plain_text', content: `${cliId} · round ${round} · ⚠ failed` },
    },
    body: { elements },
  };
}
