interface PreviewWorker {
  onmessage: ((event: { data: { revision: number, html?: string, error?: boolean } }) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(data: unknown): void;
  terminate(): void;
}

/** One in-flight render and one latest draft. Never queue all keystrokes. */
export class AsyncPreview {
  private worker?: PreviewWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private source?: string;
  private html = '';
  private busy = false;
  private ready = false;
  private disposed = false;

  constructor(
    private createWorker: () => PreviewWorker,
    private onRendered: () => void,
    private options: { filePrefix?: string, lecture?: boolean, errorHtml: string, delay?: number, timeout?: number },
  ) {}

  render = (source: string) => {
    if (!this.disposed && source !== this.source) {
      this.source = source;
      this.revision++;
      this.ready = false;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.ready = true;
        this.start();
      }, this.options.delay ?? 350);
    }
    return this.html;
  };

  private stopWorker() {
    clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    this.busy = false;
  }

  private start() {
    if (this.disposed || this.busy || !this.ready) return;
    this.ready = false;
    this.busy = true;
    const revision = this.revision;
    const finish = (html: string) => {
      if (this.disposed) return;
      clearTimeout(this.deadline);
      this.busy = false;
      if (revision === this.revision) {
        this.html = html;
        this.onRendered();
      }
      this.start();
    };
    const fail = () => {
      this.stopWorker();
      finish(this.options.errorHtml);
    };
    try {
      this.worker ||= this.createWorker();
      this.worker.onmessage = ({ data }) => {
        if (data.revision !== revision) return;
        finish(data.error ? this.options.errorHtml : data.html || '');
      };
      this.worker.onerror = fail;
      this.deadline = setTimeout(fail, this.options.timeout ?? 8000);
      this.worker.postMessage({ revision, source: this.source, filePrefix: this.options.filePrefix, lecture: this.options.lecture });
    } catch {
      fail();
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.stopWorker();
  }
}

export const editorPreviews = new Map<string, AsyncPreview>();
