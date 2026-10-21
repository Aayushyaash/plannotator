import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewAnnotationToolbarShortcuts = defineShortcutScope({
  id: 'review-annotation-toolbar',
  title: 'Review Annotation Toolbar',
  shortcuts: {
    submitComment: {
      description: 'Submit comment',
      bindings: ['Mod+Enter'],
      hint: 'With Settings → General → “Enter saves a comment” on, Enter saves too and Shift+Enter adds a new line.',
      section: 'Annotations',
      displayOrder: 10,
    },
    indentSuggestedCode: {
      description: 'Indent suggested code',
      bindings: ['Tab'],
      section: 'Annotations',
      displayOrder: 20,
    },
    cancel: {
      description: 'Close comment editor',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while the review comment editor is open.',
      displayOrder: 30,
    },
  },
});

export const useReviewAnnotationToolbarShortcuts = createShortcutScopeHook(reviewAnnotationToolbarShortcuts);
