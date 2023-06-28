import * as Y from "yjs";
import { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import {
  ySyncPluginKey,
  relativePositionToAbsolutePosition,
  absolutePositionToRelativePosition
} from "y-prosemirror";
import {
  AddAnnotationAction,
  DeleteAnnotationAction,
  UpdateAnnotationAction
} from "./collaboration-annotation";
import { AnnotationPluginKey } from "./AnnotationPlugin";
import { AnnotationItem } from "./AnnotationItem";

export interface AnnotationStateOptions {
  HTMLAttributes: {
    [key: string]: any;
  };
  map: Y.Map<any>;
  instance: string;
}

export class AnnotationState {
  options: AnnotationStateOptions;

  decorations = DecorationSet.empty;

  constructor(options: AnnotationStateOptions) {
    this.options = options;
  }

  randomId() {
    // TODO: That seems … to simple.
    return Math.floor(Math.random() * 0xffffffff).toString();
  }

  findAnnotation(id: string) {
    const current = this.decorations.find();

    for (let i = 0; i < current.length; i += 1) {
      if (current[i].spec.id === id) {
        return current[i];
      }
    }
  }

  addAnnotation(action: AddAnnotationAction, state: EditorState) {
    const ystate = ySyncPluginKey.getState(state);
    const { type, binding } = ystate;
    const { map } = this.options;
    const { from, to, data } = action;
    const relativeFrom = absolutePositionToRelativePosition(
      from,
      type,
      binding.mapping
    );
    const relativeTo = absolutePositionToRelativePosition(
      to,
      type,
      binding.mapping
    );

    map.set(this.randomId(), {
      from: relativeFrom,
      to: relativeTo,
      data
    });
  }

  updateAnnotation(action: UpdateAnnotationAction) {
    const { map } = this.options;

    const annotation = map.get(action.id);

    map.set(action.id, {
      from: annotation.from,
      to: annotation.to,
      data: action.data
    });
  }

  deleteAnnotation(id: string) {
    const { map } = this.options;

    map.delete(id);
  }

  annotationsAt(position: number) {
    return this.decorations.find(position, position).map((decoration) => {
      return new AnnotationItem(decoration);
    });
  }

  createDecorations(state: EditorState) {
    const { map, HTMLAttributes } = this.options;
    const ystate = ySyncPluginKey.getState(state);
    const { doc, type, binding } = ystate;
    const decorations: Decoration[] = [];

    map.forEach((annotation, id) => {
      const from = relativePositionToAbsolutePosition(
        doc,
        type,
        annotation.from,
        binding.mapping
      );
      const to = relativePositionToAbsolutePosition(
        doc,
        type,
        annotation.to,
        binding.mapping
      );

      if (!from || !to) {
        return;
      }

      console.log(
        `[${this.options.instance}] Decoration.inline()`,
        from,
        to,
        HTMLAttributes,
        { id, data: annotation.data }
      );

      if (from === to) {
        console.warn(
          `[${this.options.instance}] corrupt decoration `,
          annotation.from,
          from,
          annotation.to,
          to
        );
      }

      decorations.push(
        Decoration.inline(from, to, HTMLAttributes, {
          id,
          data: annotation.data,
          inclusiveEnd: true
        })
      );
    });

    this.decorations = DecorationSet.create(state.doc, decorations);
  }

  apply(transaction: Transaction, state: EditorState) {
    // Add/Remove annotations
    const action = transaction.getMeta(AnnotationPluginKey) as
      | AddAnnotationAction
      | UpdateAnnotationAction
      | DeleteAnnotationAction;

    if (action && action.type) {
      console.log(`[${this.options.instance}] action: ${action.type}`);

      if (action.type === "addAnnotation") {
        this.addAnnotation(action, state);
      }

      if (action.type === "updateAnnotation") {
        this.updateAnnotation(action);
      }

      if (action.type === "deleteAnnotation") {
        this.deleteAnnotation(action.id);
      }

      // @ts-ignore
      if (action.type === "createDecorations") {
        this.createDecorations(state);
      }

      return this;
    }

    // Use Y.js to update positions
    const ystate = ySyncPluginKey.getState(state);

    if (ystate.isChangeOrigin) {
      console.log(
        `[${this.options.instance}] isChangeOrigin: true → createDecorations`
      );
      this.createDecorations(state);

      return this;
    }

    // Use ProseMirror to update positions
    console.log(
      `[${this.options.instance}] isChangeOrigin: false → ProseMirror mapping`
    );
    this.decorations = this.decorations.map(
      transaction.mapping,
      transaction.doc
    );

    // Once ProseMirror has mapped the decorations,
    // use their new absolute positions to update the relative postions
    // of the annotations
    if (ystate.binding && ystate.binding.mapping) {
      // yDoc.transact() is important here to avoid spamming clients when we set a new annotation
      // The doc would become nearly unusable otherwise because of all the re-draws
      this.options.map.doc.transact(() => {
        this.decorations.find().forEach((deco) => {
          const id = deco.spec.id;
          const newFrom = absolutePositionToRelativePosition(
            deco.from,
            ystate.type,
            ystate.binding.mapping
          );
          const newTo = absolutePositionToRelativePosition(
            deco.to,
            ystate.type,
            ystate.binding.mapping
          );

          const annotation = this.options.map.get(id);
          annotation.from = newFrom;
          annotation.to = newTo;

          this.options.map.set(id, annotation);
        });
      }, AnnotationPluginKey);

      return this;
    }

    return this;
  }
}
