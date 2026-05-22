import { formatMessageLine, formatTime } from './format.js';

export function buildAgentPrompt({ session, cliId, peerCliIds, round, turnInput, timeZone, messages }) {
  const userUpdatesBlock = messages.render('prompt.userUpdatesBlock', {
    records: formatPromptRecords(turnInput.userUpdates, timeZone, messages),
  });

  const peerMessagesBlock = messages.render('prompt.peerMessagesBlock', {
    records: formatPromptRecords(turnInput.transcript, timeZone, messages),
  });

  if (!turnInput.includeFullContext) {
    return messages.render('prompt.delta', { userUpdatesBlock, peerMessagesBlock });
  }

  const peerList = peerCliIds && peerCliIds.length
    ? peerCliIds.join(', ')
    : messages.render('prompt.noPeers');

  return messages.render('prompt.intro', {
    peerList,
    topicContext: turnInput.topicContext || messages.render('prompt.noTopicContext'),
    userUpdatesBlock,
    peerMessagesBlock,
  });
}

function formatPromptRecords(records, timeZone, messages) {
  if (!records || records.length === 0) return messages.render('prompt.noRecords');
  return records.map((record) => formatPromptRecord(record, timeZone)).join('\n\n');
}

function formatPromptRecord(record, timeZone) {
  return formatMessageLine({
    time: formatTime(record.at, timeZone),
    sender: record.sender,
    msgType: record.msgType,
    messageId: record.messageId,
    text: record.text,
  });
}
