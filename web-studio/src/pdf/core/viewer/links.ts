/**
 * The link service pdf.js' annotation layer talks to (duck-typed
 * `IPDFLinkService`). pdf.js builds real `<a>` elements for the document's
 * links — and for URLs it recognises in the text ("auto-linking") — and asks
 * this service what clicking them does. We route everything back to Elium:
 * internal destinations to the viewer's navigation, external URLs through the
 * workspace's confirmation dialog. A link can never navigate the app window
 * itself (the desktop app is a single-page `--app` window).
 */

export interface LinkHandlers {
  /** 1-based SOURCE page number and optional offset (points from the page top). */
  goToSourcePage: (page: number, y?: number) => void;
  /** Resolve a pdf.js destination to a 1-based source page. */
  resolveDest: (dest: unknown) => Promise<{ page: number | null; y?: number }>;
  openExternal: (url: string) => void;
  /** 1-based source page currently shown (for named actions). */
  currentSourcePage: () => number;
  sourcePageCount: () => number;
}

export class EliumLinkService {
  externalLinkEnabled = true;
  /** pdf.js reads `linkService.eventBus`; set by the controller. */
  eventBus: unknown = null;

  constructor(private readonly h: LinkHandlers) {}

  get pagesCount(): number {
    return this.h.sourcePageCount();
  }
  get page(): number {
    return this.h.currentSourcePage();
  }
  set page(value: number) {
    this.h.goToSourcePage(value);
  }
  get rotation(): number {
    return 0;
  }
  set rotation(_value: number) {
    /* the viewer's rotation is Elium's, not the document's */
  }
  get isInPresentationMode(): boolean {
    return false;
  }

  setDocument(): void {}
  setViewer(): void {}
  setHistory(): void {}

  async goToDestination(dest: unknown): Promise<void> {
    const resolved = await this.h.resolveDest(dest);
    if (resolved.page) this.h.goToSourcePage(resolved.page, resolved.y);
  }

  goToPage(value: number | string): void {
    const n = typeof value === "string" ? parseInt(value, 10) : value | 0;
    if (Number.isInteger(n) && n >= 1 && n <= this.pagesCount) this.h.goToSourcePage(n);
  }

  goToXY(pageNumber: number): void {
    this.goToPage(pageNumber);
  }

  addLinkAttributes(link: HTMLAnchorElement, url: string): void {
    if (!url || typeof url !== "string") return;
    // Keep a real href (hover shows the target, a11y announces a link) but
    // never let the browser follow it.
    link.href = url;
    link.title = url;
    link.rel = "noopener noreferrer nofollow";
    link.target = "_blank";
    link.onclick = (e) => {
      e.preventDefault();
      this.h.openExternal(url);
      return false;
    };
    link.addEventListener("auxclick", (e) => e.preventDefault());
  }

  getDestinationHash(): string {
    return "#";
  }

  getAnchorUrl(anchor: string): string {
    return anchor;
  }

  setHash(): void {}

  executeNamedAction(action: string): void {
    const cur = this.h.currentSourcePage();
    switch (action) {
      case "NextPage":
        this.goToPage(Math.min(this.pagesCount, cur + 1));
        break;
      case "PrevPage":
        this.goToPage(Math.max(1, cur - 1));
        break;
      case "FirstPage":
        this.goToPage(1);
        break;
      case "LastPage":
        this.goToPage(this.pagesCount);
        break;
      default:
        break;
    }
  }

  async executeSetOCGState(): Promise<void> {
    /* layer visibility is driven by the Layers panel */
  }

  async getAttachmentContent(): Promise<null> {
    return null;
  }
}
