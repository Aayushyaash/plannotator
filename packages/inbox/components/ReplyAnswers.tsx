import type { QuestionAnswer } from '@plannotator/core/question-block';
import { plural } from '../format';
import { Icon } from '../icons';
import { pickWords, type JumpTarget } from './ReplacedQuestion';

/** One answer the reply carries: a pick saved (or being saved) on a card. */
export interface DraftAnswer {
  /** `<message id>/<key>`. */
  id: string;
  messageId: string;
  key: string;
  /** The question's number in its message (Q1, Q2…), as the reply's answers section numbers it. */
  number: number;
  prompt: string;
  /** The answer's words: the pick, Other, the text, a note. */
  answer: string;
}

/** The answer's words as the reply box lists them: the card's "Your pick" words, then a note. */
export function draftAnswerWords(answer: QuestionAnswer): string {
  const words = pickWords(answer);
  const note = answer.note?.trim();
  if (!note) return words;
  return words ? `${words} · Note: ${note}` : `Note: ${note}`;
}

/**
 * What the reply carries besides the words (the owner: "When i edit a reply,
 * and then add new answers... do they get added to the reply? Because I dont
 * see them"): every answer picked on the cards, listed live inside the reply
 * box, one row each ("Q2 Should overdue invoices sort to the top? → Yes").
 * A pick made while the box is open shows at once. A row takes the person to
 * its card. The answers are never written into the words: the Send carries
 * them under "Answers to your questions".
 */
export function ReplyAnswers({ answers, onJump }: { answers: readonly DraftAnswer[]; onJump: (target: JumpTarget) => void }) {
  const heading = answers.length === 1 ? 'Your answer goes with this reply' : `Your ${plural(answers.length, 'answer')} go with this reply`;
  return (
    <div className="ib-ranswers" data-reply-answers="" role="group" aria-label={heading}>
      <p className="ib-ranswers-h">
        <Icon name="check" size={13} />
        {heading}
      </p>
      <ul className="ib-ranswers-l">
        {answers.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="ib-ranswer"
              data-reply-answer={a.id}
              aria-label={`Q${a.number}, ${a.prompt}: ${a.answer}. Show the question.`}
              onClick={() => onJump({ kind: 'question', messageId: a.messageId, key: a.key })}
            >
              <span className="ib-ranswer-n">Q{a.number}</span> <span className="ib-ranswer-p">{a.prompt}</span>{' '}
              <span className="ib-ranswer-a">{a.answer}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
