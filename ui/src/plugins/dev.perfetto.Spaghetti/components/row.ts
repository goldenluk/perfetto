// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {Icon} from '../../../widgets/icon';
import {Button} from '../../../widgets/button';
import './row.scss';

export interface RowReorder {
  // Index of this row within its list.
  readonly index: number;
  // Called after a drop with the source index and the destination index.
  // The destination index is already adjusted for the removal of the source
  // row, so callers can simply splice-remove `from` and splice-insert at `to`.
  readonly onMove: (from: number, to: number) => void;
}

export interface RowAttrs extends m.Attributes {
  // When set, the row renders a drag handle and supports drag reordering
  // within its list. Rows can only be dropped onto siblings of the same
  // parent element, so multiple lists never interfere with each other.
  readonly reorder?: RowReorder;
}

// Returns a copy of `items` with the element at `from` moved to `to`.
// Matches the index semantics of RowReorder.onMove.
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const updated = [...items];
  const [moved] = updated.splice(from, 1);
  updated.splice(to, 0, moved);
  return updated;
}

// The row currently being dragged. Drags are document-local so a single
// module-level slot is sufficient and avoids leaking state through
// dataTransfer (which is unreadable during dragover anyway).
let dragSource: {el: HTMLElement; index: number} | null = null;

function clearDropMarkers(el: HTMLElement) {
  el.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
}

// Rows only accept drops from siblings in the same list.
function isSameList(target: HTMLElement): boolean {
  return (
    dragSource !== null && dragSource.el.parentElement === target.parentElement
  );
}

export function Row(): m.Component<RowAttrs> {
  return {
    view({attrs, children}) {
      const {reorder, ...rest} = attrs;
      if (!reorder) {
        return m('.pf-spag-row', rest, children);
      }

      const {index, onMove} = reorder;
      return m(
        '.pf-spag-row.pf-spag-row--reorderable',
        {
          ...rest,
          ondragstart: (e: DragEvent) => {
            const el = e.currentTarget as HTMLElement;
            // Firefox requires setData for the drag to start at all.
            e.dataTransfer!.setData('text/plain', '');
            e.dataTransfer!.effectAllowed = 'move';
            dragSource = {el, index};
            el.classList.add('pf-dragging');
          },
          ondragend: (e: DragEvent) => {
            const el = e.currentTarget as HTMLElement;
            el.classList.remove('pf-dragging');
            el.removeAttribute('draggable');
            dragSource = null;
          },
          ondragover: (e: DragEvent) => {
            const el = e.currentTarget as HTMLElement;
            if (!isSameList(el)) return;
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'move';
            const rect = el.getBoundingClientRect();
            const isBottom = e.clientY > rect.top + rect.height / 2;
            el.classList.toggle('pf-drag-over-top', !isBottom);
            el.classList.toggle('pf-drag-over-bottom', isBottom);
          },
          ondragleave: (e: DragEvent) => {
            clearDropMarkers(e.currentTarget as HTMLElement);
          },
          ondrop: (e: DragEvent) => {
            const el = e.currentTarget as HTMLElement;
            const isBottom = el.classList.contains('pf-drag-over-bottom');
            clearDropMarkers(el);
            if (!isSameList(el)) return;
            e.preventDefault();
            const from = dragSource!.index;
            let to = isBottom ? index + 1 : index;
            if (from === to || from + 1 === to) return;
            if (from < to) to--;
            onMove(from, to);
          },
        },
        m(Icon, {
          icon: 'drag_indicator',
          className: 'pf-spag-draghandle',
          title: 'Drag to reorder',
          // Only drags initiated from the handle should move the row;
          // dragging inside text inputs must keep selecting text. The
          // draggable attribute is toggled directly on the DOM node so it
          // takes effect before the browser decides to start a drag.
          onmousedown: (e: MouseEvent) => {
            const row = (e.currentTarget as HTMLElement).closest(
              '.pf-spag-row',
            );
            if (!(row instanceof HTMLElement)) return;
            row.setAttribute('draggable', 'true');
            document.addEventListener(
              'mouseup',
              () => row.removeAttribute('draggable'),
              {once: true},
            );
          },
        }),
        children,
      );
    },
  };
}

export namespace Row {
  export interface DeleteButtonAttrs {
    readonly onclick?: () => void;
    readonly title?: string;
  }

  export const DeleteButton: m.Component<DeleteButtonAttrs> = {
    view({attrs}) {
      return m(Button, {
        icon: 'close',
        className: 'pf-spag-delete',
        title: attrs.title ?? 'Remove',
        onclick: attrs.onclick,
      });
    },
  };
}
