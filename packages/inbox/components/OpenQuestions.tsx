import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { whenTime } from '../format';
import { Icon } from '../icons';
import {
  openQuestionPlaceWords,
  openQuestionState,
  openQuestionsHeading,
  openQuestionsLabel,
  openQuestionsSub,
  type OpenQuestion,
  type OpenQuestionPlace,
} from '../openQuestions';
import { pickWords } from './ReplacedQuestion';
import { fitFootRow, footFitCandidates, laidOutChildren, openQuestionsFormText, type FootFit, type OpenQuestionsLabelForm } from '../footFit';

export interface OpenQuestionsButtonProps {
  questions: readonly OpenQuestion[];
  /** Replaced questions left out of the list: the heading's line names them. */
  replaced: number;
  /** A phone: the button reads "5 open" at most, the list is a bottom sheet with 44 px targets. */
  phone: boolean;
  /** Where each card sits now, measured when the list opens. */
  measure: () => ReadonlyMap<string, OpenQuestionPlace>;
  /** A row was chosen: scroll to its card (opening a folded message) and ring it. */
  onPick: (question: OpenQuestion) => void;
}

/**
 * The "N open questions" button in the thread's foot and the short list it
 * opens (approval "inbox-thread-open-questions", option A): one row per open
 * question with its prompt, its state (Stopped, Holds up, or the draft pick)
 * and where its card is. Choosing a row takes the person to the real card;
 * nothing is answered here. Base UI's Menu carries the keys (arrows,
 * Home/End, type-ahead; Escape and Tab close, focus back to the button) and
 * `aria-haspopup` / `aria-expanded` on the button. On a phone the list is a
 * sheet from the bottom edge, as the project menu's. No keyboard shortcut.
 *
 * The label takes the longest form that keeps the foot's buttons on one line
 * ("5 open questions", "5 open", "5"; footFit.ts), trying each on the row's
 * usual spacing and then a tighter one; a phone never takes the long form.
 * The name always holds the whole count.
 */
export function OpenQuestionsButton({ questions, replaced, phone, measure, onPick }: OpenQuestionsButtonProps) {
  const [open, setOpen] = useState(false);
  const [places, setPlaces] = useState<ReadonlyMap<string, OpenQuestionPlace>>(new Map());
  const trigger = useRef<HTMLButtonElement>(null);
  /** A row was chosen: focus goes to its card, not back to the button. */
  const picked = useRef(false);
  // The list is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const n = questions.length;
  const max: OpenQuestionsLabelForm = phone ? 'short' : 'full';
  const [fitted, setFitted] = useState<FootFit>({ form: max, tight: false });
  const words = useRef<HTMLSpanElement>(null);
  /** What the last fit was made for: the row's width, the other buttons' words, the count. */
  const fittedFor = useRef('');
  /**
   * The longest form that keeps the row's buttons on one line, tried on the page itself (footFit.ts). Only
   * when the row's width, the buttons beside it or the count changed since the last fit.
   */
  const fit = useCallback(
    (force = false) => {
      const button = trigger.current;
      const text = words.current?.firstChild;
      const buttons = button?.parentElement;
      const row = buttons?.parentElement;
      if (!button || !text || !buttons || !row) return;
      const others = laidOutChildren(buttons)
        .filter((el) => el !== button)
        .map((el) => el.textContent ?? '')
        .join('|');
      const key = `${row.getBoundingClientRect().width}|${n}|${max}|${others}`;
      if (!force && key === fittedFor.current) return;
      fittedFor.current = key;
      const apply = ({ form, tight }: FootFit) => {
        text.nodeValue = openQuestionsFormText(n, form);
        button.setAttribute('data-label-form', form);
        button.toggleAttribute('data-fit-tight', tight);
      };
      const next = fitFootRow(buttons, footFitCandidates(max), apply) ?? { form: max, tight: false };
      // The page now shows `next` (or the longest form, where there is no layout): React draws the same.
      apply(next);
      setFitted((current) => (current.form === next.form && current.tight === next.tight ? current : next));
    },
    [n, max],
  );
  // Every render: a button beside it may have come or gone (Send, 👍) with no resize.
  useLayoutEffect(() => fit());
  useEffect(() => {
    const row = trigger.current?.parentElement?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(row);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fit(true));
    return () => observer.disconnect();
  }, [fit]);
  const form = fitted.form;
  // The button can go while its list is open (the last open questions were answered elsewhere): focus would
  // fall to the page with the list, so it goes to the foot's Reply (or Edit draft) instead.
  const openRef = useRef(false);
  openRef.current = open;
  useEffect(() => {
    const row = trigger.current?.parentElement ?? null;
    return () => {
      if (!openRef.current || !row) return;
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (!row.isConnected) return;
        row.querySelector<HTMLElement>('[data-reply-button]')?.focus();
      }, 0);
    };
  }, []);
  const label = openQuestionsLabel(n);
  const heading = openQuestionsHeading(n);
  const sub = openQuestionsSub(questions, replaced);
  const anyFolded = questions.some((q) => places.get(q.id) === 'folded');
  return (
    <Menu.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (next) {
          picked.current = false;
          setPlaces(measure());
        }
        setOpen(next);
      }}
    >
      <Menu.Trigger
        ref={trigger}
        className="ib-btn ib-oq-btn"
        data-open-questions=""
        // A shorter form ("5 open", "5"): the name keeps the whole count.
        aria-label={form === 'full' ? undefined : label}
        data-label-form={form}
        data-fit-tight={fitted.tight ? '' : undefined}
      >
        <Icon name="question" size={15} />
        <span ref={words}>{openQuestionsFormText(n, form)}</span>
        <span className="ib-oq-chev" aria-hidden="true">
          <Icon name="chevU" size={13} />
        </span>
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-oq-scrim" data-open-questions-scrim="" />}
        <Menu.Positioner
          className="ib-oq-pos"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-phone={phone ? '' : undefined}
        >
          <Menu.Popup
            className="ib-oq"
            aria-label={heading}
            data-open-questions-list=""
            finalFocus={() => (picked.current ? false : true)}
          >
            <div className="ib-oq-head">
              {/* The popup is named by the heading already (aria-label): drawn for the eye. */}
              <b aria-hidden="true">{heading}</b>
              {sub && (
                <span className="ib-oq-sub" aria-hidden="true">
                  {sub}
                </span>
              )}
              {phone && (
                <button type="button" className="ib-oq-x" aria-label="Close" data-open-questions-close="" onClick={() => setOpen(false)}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>
            <div className="ib-oq-list">
              {questions.map((q, i) => {
                const state = openQuestionState(q);
                const place = openQuestionPlaceWords(places.get(q.id) ?? 'below');
                const when = whenTime(q.at);
                const stateWords =
                  state?.kind === 'draft'
                    ? `Draft, ${q.question.answer ? pickWords(q.question.answer) : ''}`
                    : state?.kind === 'stopped'
                      ? 'Stopped'
                      : state?.kind === 'holds'
                        ? `Holds up ${state.count}`
                        : '';
                return (
                  <Menu.Item
                    key={q.id}
                    className="ib-oq-row"
                    label={q.prompt}
                    data-open-question={q.id}
                    aria-label={[q.prompt, stateWords, `${when}, ${place}`].filter(Boolean).join('. ')}
                    onClick={() => {
                      picked.current = true;
                      setOpen(false);
                      onPick(q);
                    }}
                  >
                    <span className="ib-oq-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="ib-oq-main">
                      <span className="ib-oq-p" dir="auto">
                        {q.prompt}
                      </span>
                      <span className="ib-oq-meta">
                        {state?.kind === 'draft' && (
                          <span className="ib-draft-l ib-oq-draft">
                            <b>Draft</b> <span aria-hidden="true">·</span> <span dir="auto">{q.question.answer ? pickWords(q.question.answer) : ''}</span>
                          </span>
                        )}
                        {state?.kind === 'stopped' && <span className="ib-badge ib-b-stop ib-oq-badge">Stopped</span>}
                        {state?.kind === 'holds' && <span className="ib-badge ib-b-hold ib-oq-badge">Holds up {state.count}</span>}
                        <span className="ib-oq-when">
                          {when} · {place}
                        </span>
                      </span>
                    </span>
                    <span className="ib-oq-go" aria-hidden="true">
                      <Icon name="chevR" size={15} />
                    </span>
                  </Menu.Item>
                );
              })}
            </div>
            <div className="ib-oq-foot" aria-hidden="true">
              {anyFolded ? 'Choose one to go to it. Folded messages open.' : 'Choose one to go to it.'}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
