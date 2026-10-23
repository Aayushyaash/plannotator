import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { Menu } from '@base-ui/react/menu';
import { whenTime } from '../format';
import { Icon } from '../icons';
import {
  openQuestionPlaceWords,
  openQuestionState,
  openQuestionsHeading,
  openQuestionsLabel,
  type OpenQuestion,
  type OpenQuestionPlace,
  type OpenQuestionsNoun,
} from '../openQuestions';
import { Tip } from './Tip';
import { pickWords } from './ReplacedQuestion';
import { fitFootRow, footFitCandidates, laidOutChildren, openQuestionsFormText, type FootFit, type OpenQuestionsLabelForm } from '../footFit';

/** The Re-ask item at the list's foot (owner, 2026-10-23): what the foot's Re-ask button did. */
export interface OpenQuestionsReask {
  /** "Re-ask in one new message" / "Re-ask in a new message". */
  label: string;
  /** What pressing it does (the old button's tooltip). */
  tooltip: string;
  /** A Re-ask is being sent: the item is disabled. */
  busy: boolean;
  onReask: () => void;
}

export interface OpenQuestionsButtonProps {
  questions: readonly OpenQuestion[];
  /**
   * Shown with no question listed (only action items wait, and Re-ask is
   * offered): the button counts the open action items instead.
   */
  actions?: number;
  /** Re-ask, when it is offered: one item at the list's foot. */
  reask?: OpenQuestionsReask | null;
  /** The button itself, for whoever puts focus back on it (the Re-ask route choice's Cancel). */
  triggerRef?: Ref<HTMLButtonElement>;
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
export function OpenQuestionsButton({ questions, actions = 0, reask = null, triggerRef, phone, measure, onPick }: OpenQuestionsButtonProps) {
  const [open, setOpen] = useState(false);
  const [places, setPlaces] = useState<ReadonlyMap<string, OpenQuestionPlace>>(new Map());
  const trigger = useRef<HTMLButtonElement>(null);
  /** A row was chosen: focus goes to its card, not back to the button. */
  const picked = useRef(false);
  // The list is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // Only action items wait (Re-ask is offered): the button counts them.
  const noun: OpenQuestionsNoun = questions.length === 0 && actions > 0 ? 'action item' : 'question';
  const n = noun === 'question' ? questions.length : actions;
  const reaskTipId = useId();
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
        text.nodeValue = openQuestionsFormText(n, form, noun);
        button.setAttribute('data-label-form', form);
        button.toggleAttribute('data-fit-tight', tight);
      };
      const next = fitFootRow(buttons, footFitCandidates(max), apply) ?? { form: max, tight: false };
      // The page now shows `next` (or the longest form, where there is no layout): React draws the same.
      apply(next);
      setFitted((current) => (current.form === next.form && current.tight === next.tight ? current : next));
    },
    [n, max, noun],
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
  const label = openQuestionsLabel(n, noun);
  const heading = openQuestionsHeading(n, noun);
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
        ref={(el: HTMLButtonElement | null) => {
          trigger.current = el;
          if (typeof triggerRef === 'function') triggerRef(el);
          else if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = el;
        }}
        className="ib-btn ib-oq-btn"
        data-open-questions=""
        // A shorter form ("5 open", "5"): the name keeps the whole count.
        aria-label={form === 'full' ? undefined : label}
        data-label-form={form}
        data-fit-tight={fitted.tight ? '' : undefined}
      >
        <Icon name="question" size={15} />
        <span ref={words}>{openQuestionsFormText(n, form, noun)}</span>
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
            {/* No drawn heading or foot line (owner, 2026-10-23): the popup's name (aria-label) carries the count. */}
            {phone && (
              <div className="ib-oq-head">
                <button type="button" className="ib-oq-x" aria-label="Close" data-open-questions-close="" onClick={() => setOpen(false)}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}
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
            {reask && (
              <>
                {questions.length > 0 && <Menu.Separator className="ib-oq-sep" />}
                <Tip content={reask.tooltip}>
                  <Menu.Item
                    className="ib-oq-reask"
                    data-reask=""
                    label={reask.label}
                    disabled={reask.busy}
                    aria-describedby={reaskTipId}
                    onClick={() => {
                      // Focus goes back to the button (or to the route choice, which takes it).
                      setOpen(false);
                      reask.onReask();
                    }}
                  >
                    <Icon name="refresh" size={15} />
                    <span>{reask.label}</span>
                  </Menu.Item>
                </Tip>
                {/* The tooltip tags nothing for a screen reader: the same words as the item's description. */}
                <span id={reaskTipId} hidden>
                  {reask.tooltip}
                </span>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
