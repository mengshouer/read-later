/**
 * A DOM stub just large enough to run the injected functions for real.
 *
 * The point is not fidelity — it is isolation. The tests rebuild each injected
 * function with `new Function`, whose scope chain is the global object only.
 * That reproduces exactly what Chrome does when it serialises `func` and
 * re-parses it inside the page: any reference to a module-scope helper becomes
 * a ReferenceError instead of silently working in the test.
 */

export interface FakeRect {
  top: number;
  bottom: number;
  height: number;
}

export interface FakeBlock {
  /** What the block renders — `innerText`, and what an anchor is actually built from. */
  text: string;
  /**
   * `textContent`, when it differs. Markup can carry text that does not render: a JSON-LD
   * `<script>` inside an `article > div` is the common case, and the difference between the two
   * properties is what a length gate has to be careful about. Defaults to `text`.
   */
  textContent?: string;
  rect: FakeRect;
}

export interface FakeLink {
  href: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  imgAlt?: string;
}

export interface FakeDomOptions {
  title?: string;
  href?: string;
  hostname?: string;
  bodyText?: string;
  blocks?: FakeBlock[];
  links?: FakeLink[];
  hasFeedRole?: boolean;
  decodedBodySize?: number;
  scrollY?: number;
  innerHeight?: number;
  scrollHeight?: number;
  fragmentSupported?: boolean;
}

export interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  innerText: string;
  style: Record<string, string>;
  children: FakeElement[];
  parentNode: FakeElement | null;
  shadow: FakeElement | null;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(event: unknown) => void>>;
  appendChild(child: FakeElement): FakeElement;
  remove(): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  attachShadow(options: { mode: string }): FakeElement;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  querySelector(selector: string): FakeElement | null;
  getBoundingClientRect(): FakeRect;
  focus(): void;
  fire(type: string, event?: unknown): void;
}

export interface FakeDom {
  document: Record<string, unknown>;
  window: Record<string, unknown>;
  location: { href: string; hostname: string };
  performance: { getEntriesByType(type: string): unknown[] };
  /** Every element created during the run, in creation order. */
  created: FakeElement[];
  findByText(text: string): FakeElement | undefined;
  fireDocument(type: string, event: unknown): void;
}

export function createFakeDom(options: FakeDomOptions = {}): FakeDom {
  const created: FakeElement[] = [];
  const byId = new Map<string, FakeElement>();
  const documentListeners: Record<string, Array<(event: unknown) => void>> = {};

  function makeElement(tagName: string, seed: Partial<FakeElement> = {}): FakeElement {
    const element: FakeElement = {
      tagName: tagName.toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      innerText: '',
      style: {},
      children: [],
      parentNode: null,
      shadow: null,
      attrs: {},
      listeners: {},
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        if (child.id) byId.set(child.id, child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
          this.parentNode = null;
        }
        if (this.id) byId.delete(this.id);
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
        if (name === 'id') {
          this.id = value;
          byId.set(value, this);
        }
      },
      getAttribute(name) {
        return name in this.attrs ? (this.attrs[name] as string) : null;
      },
      attachShadow() {
        this.shadow = makeElement('#shadow-root');
        return this.shadow;
      },
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      },
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
      },
      querySelector(selector) {
        if (selector === 'img' && this.attrs['data-img-alt'] !== undefined) {
          const img = makeElement('img');
          img.setAttribute('alt', this.attrs['data-img-alt'] as string);
          return img;
        }
        return null;
      },
      getBoundingClientRect() {
        return (this.attrs['data-rect'] ? JSON.parse(this.attrs['data-rect'] as string) : null) ?? {
          top: 0,
          bottom: 0,
          height: 0,
        };
      },
      focus() {
        this.attrs['data-focused'] = 'true';
      },
      fire(type, event) {
        (this.listeners[type] ?? []).forEach((fn) => fn(event ?? {}));
      },
      ...seed,
    };
    created.push(element);
    return element;
  }

  const blocks = (options.blocks ?? []).map((block) => {
    const element = makeElement('p');
    element.textContent = block.textContent ?? block.text;
    element.innerText = block.text;
    element.setAttribute('data-rect', JSON.stringify(block.rect));
    return element;
  });

  const links = (options.links ?? []).map((link) => {
    const element = makeElement('a');
    element.setAttribute('href', link.href);
    (element as unknown as { href: string }).href = link.href;
    element.textContent = link.text ?? '';
    element.innerText = link.text ?? '';
    if (link.title !== undefined) element.setAttribute('title', link.title);
    if (link.ariaLabel !== undefined) element.setAttribute('aria-label', link.ariaLabel);
    if (link.imgAlt !== undefined) element.setAttribute('data-img-alt', link.imgAlt);
    return element;
  });

  const body = makeElement('body');
  body.textContent = options.bodyText ?? '';
  body.innerText = options.bodyText ?? '';

  const documentElement = makeElement('html');

  const document: Record<string, unknown> = {
    title: options.title ?? '',
    body,
    documentElement,
    scrollingElement: {
      scrollTop: options.scrollY ?? 0,
      scrollHeight: options.scrollHeight ?? 10_000,
      clientHeight: options.innerHeight ?? 800,
    },
    links,
    createElement: (tag: string) => makeElement(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: (selector: string) => (selector === '[role="feed"]' && options.hasFeedRole ? body : null),
    querySelectorAll: () => blocks,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (documentListeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  if (options.fragmentSupported !== false) document['fragmentDirective'] = {};

  const window: Record<string, unknown> = {
    scrollY: options.scrollY ?? 0,
    innerHeight: options.innerHeight ?? 800,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as NodeJS.Timeout),
  };

  return {
    document,
    window,
    location: {
      href: options.href ?? 'https://example.com/post/1',
      hostname: options.hostname ?? 'example.com',
    },
    performance: {
      getEntriesByType: () => [{ decodedBodySize: options.decodedBodySize ?? 200_000 }],
    },
    created,
    findByText: (text: string) => created.find((element) => element.textContent === text),
    fireDocument: (type: string, event: unknown) => {
      (documentListeners[type] ?? []).slice().forEach((fn) => fn(event));
    },
  };
}

/**
 * Rebuilds a function from its own source in a scope containing nothing but the
 * supplied browser globals — the isolation Chrome actually gives injected code.
 */
export function reconstruct<T extends (...args: never[]) => unknown>(fn: T, dom: FakeDom): T {
  const factory = new Function(
    'document',
    'window',
    'location',
    'performance',
    `return (${fn.toString()});`,
  ) as (...globals: unknown[]) => T;
  return factory(dom.document, dom.window, dom.location, dom.performance);
}
