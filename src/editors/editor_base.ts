import { Area, UIBase, nstructjs, contextWrangler } from "../pathux";
import type { ColumnFrame } from "../pathux";

/** Base for the app's editors: a column container with a header, and context push/pop. */
export class Editor extends Area {
  container!: ColumnFrame;

  constructor() {
    super();
    this.useDataPathUndo = true;
  }

  on_fileload(_isActiveEditor: boolean) {}

  push_ctx_active() {
    contextWrangler.updateLastRef(this.constructor, this);
    contextWrangler.push(this.constructor, this);
  }

  pop_ctx_active() {
    contextWrangler.pop(this.constructor, this);
  }

  init() {
    super.init();

    this.container = UIBase.createElement<ColumnFrame>("colframe-x");
    this.container.ctx = this.ctx;
    this.shadow.appendChild(this.container);

    this.header = this.makeHeader(this.container, true);
  }

  /** Splitting an area copies its editor; subclasses with state override this. */
  copy() {
    const cls = this.constructor as unknown as { define(): { tagname: string } };
    const ret = UIBase.createElement<Editor>(cls.define().tagname);
    ret.ctx = this.ctx;
    return ret;
  }
}
Editor.STRUCT = nstructjs.STRUCT.inherit(Editor, Area, "sa3d.Editor") + "\n}\n";
nstructjs.register(Editor);
