/**
 * The Inbox's one composer field (approval "inbox-skill-references"): the
 * reply box, New message, and compose (a message the person starts) all
 * render this. It is Plannotator's comment composer field, unchanged in
 * behavior: the `/` and `$` skill picker at the start of a word
 * (`useSkillReferenceAutocomplete`, `SkillReferenceMenu`), the highlight
 * layer that paints a reference (`ComposerTokenTextarea`, a dotted underline
 * on a human-only skill), and the quiet "Includes skill instructions" line
 * under it. The text stays plain: `$write-better` is the reference, and the
 * Send composes the block (skills.ts).
 *
 * With `tags` (the reply box; approval "inbox-tag-agents"), `@` at the start
 * of a word opens the agent picker (TagPicker), driven by ui's
 * `useMentionAutocomplete` with agents offered: a pick becomes a readable
 * `@Pi` chip in the text, and the field reports the sessions still tagged.
 * Under the field, "Goes to" and the heads-ups (TagNotes).
 *
 * Keys: the pickers see a key first and take only what it was aimed at (a
 * row arrowed onto, Escape with a picker open), so Enter, Tab and Mod+Enter
 * keep their meaning and the host's own `onKeyDown` gets everything else.
 * With no skills installed (or the route missing) `/` and `$` are plain text.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ComposerTokenTextarea } from '@plannotator/ui/components/ComposerTokenTextarea';
import { HumanOnlySkillNotice, SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { useMentionAutocomplete } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import type { MentionPerson, MentionSource } from '@plannotator/ui/utils/mentions';
import { TAG_UPDATE_WORDS, tagPeople, tagPickedWords, type TagOption } from '../tags';
import { TagNotes, TagPicker } from './TagPicker';

/** The chip class a tag gets in the composer's highlight layer (inbox.css: colour, background and box-shadow only). */
export const TAG_TOKEN_CLASS = 'ib-tg-tok';

export interface InboxComposerTags {
  /** The rows the picker offers (tags.ts `tagOptions`). */
  options: readonly TagOption[];
  /** The sessions the text still tags, in order, every time they change. */
  onChange: (ids: readonly string[]) => void;
}

export interface InboxComposerFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The host's keys (Mod+Enter sends, Escape closes); called only for keys the picker did not take. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The textarea, for the host's focus calls. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  /** What the human-only line says the instructions go with: "your reply", "your message". */
  destination: string;
  /** Tag agents with `@` (the reply box). Absent: `@` is plain text, as before. */
  tags?: InboxComposerTags;
}

const NO_PEOPLE: readonly MentionPerson[] = [];

export function InboxComposerField({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  destination,
  tags,
}: InboxComposerFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );
  const skills = useSkillReferenceAutocomplete({ text: value, setText: onChange, textareaRef: innerRef, enabled: true });
  const [announce, setAnnounce] = useState('');
  const options = tags?.options;
  const onTagsChange = tags?.onChange;
  const people = useMemo(() => (options ? tagPeople(options) : NO_PEOPLE), [options]);
  const source = useMemo<MentionSource | undefined>(
    () =>
      options
        ? {
            people,
            kinds: ['agent'],
            matchDetail: false,
            // Only a bare `@` with nobody to offer says so; a query nobody matches closes the picker (prose after a tag).
            emptyNotice: options.length === 0 ? 'No agent to tag: none is live, and none reads the Inbox yet.' : null,
            tokenClassName: TAG_TOKEN_CLASS,
            onMentionsChange: (ids) => onTagsChange?.(ids),
            // A session on an older Plannotator: nothing is inserted; say why.
            onPickBlocked: (person) => setAnnounce(`${person.label}: ${TAG_UPDATE_WORDS}.`),
          }
        : undefined,
    [options, people, onTagsChange],
  );
  const mention = useMentionAutocomplete({ text: value, setText: onChange, textareaRef: innerRef, source });
  // The agents can arrive after the person typed `@` (the list is read when the box opens): read the caret then.
  const tagsReady = source !== undefined;
  const readMentionCaret = mention.onSelect;
  useEffect(() => {
    if (tagsReady) readMentionCaret();
  }, [tagsReady, readMentionCaret]);
  const skillListboxId = `ib-skills-${useId().replace(/:/g, '')}`;
  const tagListboxId = `ib-tags-${useId().replace(/:/g, '')}`;
  const notesId = `ib-tagnotes-${useId().replace(/:/g, '')}`;
  const tagged = useMemo(() => (options ? mention.mentions.flatMap((p) => options.filter((o) => o.id === p.id)) : []), [options, mention.mentions]);
  const owner = options?.find((o) => o.owner) ?? null;
  const showNotes = tagged.some((t) => !t.owner);
  const skillActive = skills.menu?.activeIndex;
  const tagMenu = mention.menu;
  const listboxId = tagMenu ? tagListboxId : skillListboxId;
  const activeOption =
    tagMenu && tagMenu.activeIndex !== null
      ? `${tagListboxId}-option-${tagMenu.activeIndex}`
      : !tagMenu && skillActive !== null && skillActive !== undefined
        ? `${skillListboxId}-option-${skillActive}`
        : undefined;
  const select = (index: number) => {
    const person = tagMenu?.items[index];
    const option = person ? options?.find((o) => o.id === person.id) : undefined;
    mention.select(index);
    if (option?.taggable) setAnnounce(tagPickedWords(option));
  };
  const describedBy = [ariaDescribedBy, showNotes ? notesId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ib-cfield" data-composer-field="">
      {skills.menu && !tagMenu && (
        <SkillReferenceMenu id={skillListboxId} items={skills.menu.items} activeIndex={skills.menu.activeIndex} onSelect={skills.select} />
      )}
      {tagMenu && options && <TagPicker id={tagListboxId} menu={tagMenu} options={options} onSelect={select} />}
      <ComposerTokenTextarea
        textareaRef={attach}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          skills.onSelect();
          mention.onSelect();
        }}
        onKeyDown={(event) => {
          if (tagMenu && (event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey && tagMenu.activeIndex !== null) {
            event.preventDefault();
            select(tagMenu.activeIndex);
            return;
          }
          if (mention.onKeyDown(event)) return;
          if (skills.onKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onSelectCaret={() => {
          skills.onSelect();
          mention.onSelect();
        }}
        placeholder={placeholder}
        sizeClassName=""
        textClassName=""
        inputClassName="ib-rtext"
        mirrorClassName="ib-rmirror"
        skillReferences
        tokens={skills.referenceTokens}
        mentionChips={source ? { people: mention.mentions, tokenClassName: TAG_TOKEN_CLASS } : null}
        listboxId={listboxId}
        listboxOpen={skills.menu !== null || tagMenu !== null}
        activeOptionId={activeOption}
        inputProps={{ 'aria-label': ariaLabel, 'aria-describedby': describedBy, rows: 2 }}
      />
      <HumanOnlySkillNotice skills={skills.humanOnlyReferences} destination={destination} />
      {options && showNotes && <TagNotes id={notesId} tagged={tagged} owner={owner} />}
      {options && (
        <div className="ib-sr" role="status" aria-live="polite" data-tag-live="">
          {tagMenu ? `${tagMenu.items.length} ${tagMenu.items.length === 1 ? 'agent' : 'agents'}${announce ? `. ${announce}` : ''}` : announce}
        </div>
      )}
    </div>
  );
}
