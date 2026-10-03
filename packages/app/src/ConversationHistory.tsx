import { CitationLink, citationLabel } from "./components/CitationLink.js";
import type { ConversationHistoryState } from "./conversationState.js";

export type ConversationHistoryProps = {
  projectId: string;
  history: ConversationHistoryState;
  droppedCitations: number;
  onRetry: () => void;
};

/**
 * The durable side of the conversation: every stored transcript and its
 * citations, read from the authorized server query. It renders during every
 * stage (listening included) and is re-read on mount, so a page/app reconnect
 * restores it instead of losing it — nothing here lives only in the browser.
 */
export function ConversationHistory({ projectId, history, droppedCitations, onRetry }: ConversationHistoryProps) {
  let content;
  if (history.status === "loading") {
    content = (
      <p role="status" className="state-block">
        Loading your conversation…
      </p>
    );
  } else if (history.status === "error") {
    content = (
      <div role="alert" className="state-block">
        <p>The conversation history could not be loaded.</p>
        <p>
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </p>
      </div>
    );
  } else if (history.messages.length === 0) {
    content = <p role="status">No turns yet. Your transcripts and citations appear here and survive a reload.</p>;
  } else {
    content = (
      <ol className="history-list">
        {history.messages.map((message) => (
          <li key={`${message.turnId}:${message.role}:${message.createdAt}`} className="history-item" data-role={message.role}>
            <p className="history-speaker">{message.role === "learner" ? "You" : "Tutor"}</p>
            <p className="history-text">{message.content}</p>
            {message.role === "tutor" && message.citations.length > 0 && (
              <ul className="history-citations" aria-label={`Sources cited in this answer`}>
                {message.citations.map((citation) => (
                  <li key={citation.chunkId}>
                    <CitationLink projectId={projectId} citation={citation}>
                      {`${citation.rank}. ${citationLabel(citation)}`}
                    </CitationLink>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <section aria-label="Conversation history" className="conversation-history">
      <h3>Conversation history</h3>
      {content}
      {history.status === "ready" && droppedCitations > 0 && (
        <p role="status" className="history-note">
          {droppedCitations} citation{droppedCitations === 1 ? "" : "s"} no longer resolve to an available source and were hidden.
        </p>
      )}
    </section>
  );
}
