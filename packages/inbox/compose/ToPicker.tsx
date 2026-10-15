import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HostMark, Icon } from '../icons';
import { tildePath } from '../format';
import { splitPath } from '../agents';
import { filterGroups, hostLabel, pickerRows, type ComposeGroup, type ComposeTarget } from './model';

/**
 * The To picker (compose; approval "inbox-compose-to-picker"): a filter field
 * over one listbox of live sessions, one line each: the agent's mark and
 * name, the project, its folder (muted, cut in the middle), a check on the
 * chosen one. A start time shows only where one project has two or more live
 * sessions. The current project first, then the most recently active.
 * ↓ ↑ move a wrapping highlight, Enter picks, Escape closes the picker only
 * (the dialog stays), typing filters by host, project and last subject.
 * Focus stays in the filter (`aria-activedescendant`).
 */
export function ToPicker({
  groups,
  selected,
  home,
  phone,
  onPick,
  onClose,
}: {
  groups: readonly ComposeGroup[];
  selected: string | null;
  home: string | null;
  phone: boolean;
  onPick: (target: ComposeTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const rows = useMemo(() => pickerRows(shown, groups), [shown, groups]);
  const options = useMemo(() => rows.map((row) => row.target), [rows]);
  // The highlight follows a session, not a row number: the list is read again
  // every 5 s, and a re-read that moves rows must not move the highlight.
  const [hlSession, setHlSession] = useState<string | null>(null);
  const found = options.findIndex((t) => t.session === hlSession);
  const hl = found >= 0 ? found : 0;
  const setHl = (index: number) => setHlSession(options[index]?.session ?? null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The highlight starts on the session To names, else the first row; a new filter snaps it to the first row.
  useLayoutEffect(() => {
    const at = options.findIndex((t) => t.session === selected);
    setHl(query === '' && at >= 0 ? at : 0);
    // Only the filter moves it; the re-read keeps the session it is on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  // A press outside closes it (the To button toggles it itself).
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('[data-compose-to]')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      // The picker only: the dialog's own Escape never sees this one.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHl((hl + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = options[hl];
      if (target) onPick(target);
    }
  };

  return (
    <div className="ib-cp-picker" ref={ref} data-compose-picker="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onClose}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>To</span>
        </div>
      )}
      <div className="ib-cp-filter">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-cp-list-${uid}`}
          aria-activedescendant={options[hl] ? optionId(hl) : undefined}
          aria-label="Find an agent or project"
          placeholder="Find an agent or project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-list-${uid}`} aria-label="Live agent sessions">
        {rows.length === 0 && <div className="ib-cp-none">No live session matches.</div>}
        {rows.map(({ target, started }, i) => {
          const folder = tildePath(target.project.root, home);
          return (
            <div
              key={target.session}
              id={optionId(i)}
              role="option"
              aria-selected={i === hl}
              aria-label={`${hostLabel(target.host)} in ${target.project.name}, ${folder}${started ? `, started ${started}` : ''}`}
              className={`ib-cp-opt${i === hl ? ' ib-hl' : ''}`}
              data-compose-session={target.session}
              data-compose-project={target.project.name}
              onPointerMove={() => i !== hl && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(target)}
            >
              <HostMark host={target.host} />
              <b className="ib-cp-oa">{hostLabel(target.host)}</b>
              <span className="ib-cp-op" dir="auto">
                {target.project.name}
              </span>
              <FolderPath path={folder} />
              <span className="ib-cp-os" data-compose-started={started ?? undefined} title={started ? `Started ${started}` : undefined}>
                {started ? `· ${started}` : null}
              </span>
              <span className="ib-cp-check" aria-hidden="true">
                {target.session === selected && <Icon name="check" size={15} />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A project folder on one line, cut in the middle: the leading folders shrink with "…", the last name stays; the whole path in `title`. */
function FolderPath({ path }: { path: string }) {
  const split = splitPath(path);
  // The slash before the last name stays with it, so a cut reads "~/pando/proj…/main".
  const moveSlash = split.head.endsWith('/') && split.head.length > 1;
  const head = moveSlash ? split.head.slice(0, -1) : split.head;
  const tail = moveSlash ? `/${split.tail}` : split.tail;
  const segments = (part: string) =>
    part.split('/').map((name, index, all) => (
      <Fragment key={index}>
        {name && <bdi>{name}</bdi>}
        {index < all.length - 1 && '/'}
      </Fragment>
    ));
  return (
    <span className="ib-cp-of" dir="ltr" title={path}>
      <span className="ib-cp-ofh">{segments(head)}</span>
      <span className="ib-cp-oft">{segments(tail)}</span>
    </span>
  );
}
