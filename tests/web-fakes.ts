/**
 * Minimal Playwright-shaped fakes for browser-side logic tests. Behavior is
 * configured, not simulated: buttons/inputs/responses are declared per test
 * and the fake locator dispatches by selector kind.
 */

export interface FakeButton {
  text: string;
  visible?: boolean;
  clicks?: number;
}

export interface FakeInput {
  visible?: boolean;
  isAuth?: boolean;
  clicks?: number;
}

export interface FakePageOptions {
  url?: string;
  bodyText?: string;
  buttons?: FakeButton[];
  inputs?: FakeInput[];
  authInputCount?: number;
  /** Responses returned in order on successive reads; last one repeats. */
  responseSequence?: string[];
  closed?: boolean;
}

class FakeLocator {
  private readonly pinnedItems?: unknown[];
  constructor(
    private readonly page: FakePage,
    private readonly kind: "buttons" | "inputs" | "responses" | "auth" | "close-buttons",
    pinnedItems?: unknown[],
  ) {
    this.pinnedItems = pinnedItems;
  }

  private items() {
    if (this.pinnedItems !== undefined) return this.pinnedItems;
    switch (this.kind) {
      case "buttons":
        return this.page.options.buttons ?? [];
      case "inputs":
        return this.page.options.inputs ?? [];
      case "responses":
        return this.page.responseItems();
      case "auth":
        return new Array(this.page.options.authInputCount ?? 0).fill({});
      case "close-buttons":
        return (this.page.options.buttons ?? []).filter((b) => b.text === "×");
    }
  }

  async isVisible(): Promise<boolean> {
    const items = this.items();
    const first = items[0] as { visible?: boolean } | undefined;
    return items.length > 0 && (first?.visible ?? true);
  }
  async count(): Promise<number> {
    return this.items().length;
  }
  first(): FakeLocator {
    return this.sliceLocator(0);
  }
  last(): FakeLocator {
    return this.sliceLocator(-1);
  }
  private sliceLocator(index: number): FakeLocator {
    const items = this.items();
    const item = index < 0 ? items[items.length - 1] : items[index];
    // Pin the narrowed list on the locator itself — never clone the page,
    // which would drop FakePage methods like responseItems().
    return new FakeLocator(this.page, this.kind, item !== undefined ? [item] : []);
  }
  async all(): Promise<FakeLocator[]> {
    const items = this.items();
    return items.map((item) => new FakeLocator(this.page, this.kind, [item]));
  }
  async click(): Promise<void> {
    const items = this.items();
    const item = items[0] as { clicks?: number; visible?: boolean } | undefined;
    if (!item) throw new Error("no element to click");
    if (item.visible === false) throw new Error("element not visible");
    item.clicks = (item.clicks ?? 0) + 1;
    // Popup buttons vanish once dismissed; a chat input stays put after focus.
    if (this.kind === "buttons" || this.kind === "close-buttons") item.visible = false;
  }
  async innerText(): Promise<string> {
    const items = this.items();
    const item = items[0] as FakeButton | string | undefined;
    if (typeof item === "string") return item;
    return item?.text ?? "";
  }
  async waitFor(): Promise<void> {
    if (!(await this.isVisible())) throw new Error("waitFor timeout");
  }
  async evaluate(fn: (el: unknown) => unknown): Promise<unknown> {
    return fn({ tagName: "TEXTAREA", getAttribute: () => "" });
  }
}

export class FakePage {
  responseReads = 0;
  popupSweepCount = 0;
  insertedText = "";
  enterPresses = 0;
  private closedFlag: boolean;

  constructor(readonly options: FakePageOptions) {
    this.closedFlag = options.closed ?? false;
  }

  url(): string {
    return this.options.url ?? "https://chat.example.com/";
  }
  isClosed(): boolean {
    return this.closedFlag;
  }
  close(): Promise<void> {
    this.closedFlag = true;
    return Promise.resolve();
  }
  frames(): FakePage[] {
    return [];
  }
  mainFrame(): FakePage {
    return this;
  }
  waitForTimeout(_ms: number): Promise<void> {
    // Each poll tick advances the stream one step, like a live page.
    const seq = this.options.responseSequence ?? [];
    if (seq.length > 0) this.responseReads = Math.min(this.responseReads + 1, seq.length - 1);
    return Promise.resolve();
  }
  goto(): Promise<void> {
    return Promise.resolve();
  }
  screenshot(): Promise<void> {
    return Promise.resolve();
  }
  readonly keyboard = {
    insertText: (text: string) => {
      this.insertedText = text;
      return Promise.resolve();
    },
    press: (_key: string) => {
      this.enterPresses += 1;
      return Promise.resolve();
    },
  };
  evaluate(fn: () => unknown): Promise<unknown> {
    if (fn.toString().includes("innerText")) return Promise.resolve(this.options.bodyText ?? "");
    return Promise.resolve(undefined);
  }

  responseItems(): string[] {
    const seq = this.options.responseSequence ?? [];
    if (seq.length === 0) return [];
    const index = Math.min(this.responseReads, seq.length - 1);
    return [seq[index]];
  }

  locator(selector: string): FakeLocator {
    if (/button|\[role="button"\]/.test(selector) && !/close|modal|dialog/i.test(selector)) return new FakeLocator(this, "buttons");
    if (/close|modal|dialog/i.test(selector)) return new FakeLocator(this, "close-buttons");
    if (/input\[type="email"\]|input\[type="password"\]|autocomplete/.test(selector)) return new FakeLocator(this, "auth");
    if (/textbox|contenteditable|textarea/.test(selector) && !/type=/.test(selector)) return new FakeLocator(this, "inputs");
    // response selectors
    return new FakeLocator(this, "responses");
  }
}

export class FakeContext {
  readonly created: FakePage[] = [];
  constructor(private readonly pageFactory: () => FakePage) {}
  pages(): FakePage[] {
    return [];
  }
  newPage(): Promise<FakePage> {
    const page = this.pageFactory();
    if (this.created.includes(page) && page.isClosed()) {
      (page as any).closedFlag = false;
    }
    this.created.push(page);
    return Promise.resolve(page);
  }
}
