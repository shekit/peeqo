/**
 * What Peeqo remembers about its person from one conversation to the next: short facts ("Lives in Pune, India.")
 * kept as a Markdown list (memory.md) that anyone can open, read and edit. The model adds, updates and removes
 * facts itself (the remember and forget tools), and sees them all on every turn.
 */
export interface NotesStore {
  /** The saved Markdown, or null if there is none yet. */
  load(): Promise<string | null> | string | null;
  save(markdown: string): Promise<void> | void;
}

export interface MemoryOptions {
  readonly store?: NotesStore | null;
  /** Most facts kept (default 100): when full, the model has to merge or forget something first. */
  readonly maxFacts?: number;
  /** Called after every change (to show the facts, say). */
  readonly onChange?: (facts: readonly string[]) => void;
  /** Called when saving fails (the facts stay in memory, and the next change tries again). */
  readonly onError?: (error: unknown) => void;
}

const MAX_FACT_LENGTH = 200;
const HEADER = '# What Peeqo remembers\n\nFacts about you, one per line. Peeqo keeps them up to date; edit or delete lines as you like.\n\n';

/** Lowercase letters and digits only, for comparing facts. */
const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One line, without list markers, at most MAX_FACT_LENGTH characters. */
function cleanFact(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*+#>]\s*)+/, '')
    .slice(0, MAX_FACT_LENGTH)
    .trim();
}

/** The facts in a Markdown file: its list items ("- …", "* …" or "+ …"), without duplicates. */
export function parseFacts(markdown: string, max = Infinity): string[] {
  const facts: string[] = [];
  for (const line of markdown.split('\n')) {
    const item = /^\s*[-*+]\s+(.+)$/.exec(line)?.[1];
    const fact = item ? cleanFact(item) : '';
    if (fact && !facts.some((f) => normal(f) === normal(fact))) facts.push(fact);
    if (facts.length >= max) break;
  }
  return facts;
}

export class Memory {
  readonly maxFacts: number;
  #facts: string[] = [];
  readonly #store: NotesStore | null;
  readonly #onChange: (facts: readonly string[]) => void;
  readonly #onError: (error: unknown) => void;
  /** Saves happen one after another, in order. */
  #saving: Promise<void> = Promise.resolve();

  constructor(options: MemoryOptions = {}) {
    this.#store = options.store ?? null;
    this.maxFacts = options.maxFacts ?? 100;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
  }

  get facts(): readonly string[] {
    return this.#facts;
  }

  /** Loads the saved facts. */
  async load(): Promise<void> {
    const markdown = await this.#store?.load();
    this.#facts = markdown ? parseFacts(markdown, this.maxFacts) : [];
    this.#onChange(this.#facts);
  }

  /** Adds a fact, or with `replaces`, updates the fact it names. Returns what happened, in words for the model. */
  remember(fact: string, replaces?: string): string {
    const clean = cleanFact(fact);
    if (!clean) return 'error: give the fact as a short sentence';
    const old = replaces ? this.#find(replaces) : -1;
    if (old >= 0) {
      const before = this.#facts[old]!;
      // Updating to a fact that is already there elsewhere: keep just the one.
      const twin = this.#facts.findIndex((f, i) => i !== old && normal(f) === normal(clean));
      this.#facts = this.#facts.flatMap((f, i) => (i === old ? (twin >= 0 ? [] : [clean]) : [f]));
      this.#changed();
      return `updated "${before}" to "${clean}"`;
    }
    if (this.#facts.some((f) => normal(f) === normal(clean))) return `already remembered: "${clean}"`;
    if (this.#facts.length >= this.maxFacts) return `error: your memory is full (${this.maxFacts} facts); merge or forget something less useful first`;
    this.#facts = [...this.#facts, clean];
    this.#changed();
    return `remembered "${clean}"${replaces ? ` (nothing matched "${cleanFact(replaces).slice(0, 60)}", so it was added)` : ''}`;
  }

  /**
   * Forgets the fact `words` names: the one that matches exactly, otherwise every fact containing those words; or
   * with `all`, everything. Returns what happened, in words for the model.
   */
  forget(words: string | null, all = false): string {
    if (all) {
      const count = this.#facts.length;
      this.#facts = [];
      if (count > 0) this.#changed();
      return count > 0 ? `forgot all ${count} facts` : 'there was nothing to forget';
    }
    const key = normal(words ?? '');
    if (!key) return 'error: say which fact to forget';
    const exact = this.#facts.findIndex((f) => normal(f) === key);
    const gone = exact >= 0 ? [this.#facts[exact]!] : this.#facts.filter((f) => normal(f).includes(key));
    if (gone.length === 0) return `nothing matched "${cleanFact(words ?? '').slice(0, 60)}"; nothing was forgotten`;
    this.#facts = this.#facts.filter((f) => !gone.includes(f));
    this.#changed();
    return `forgot ${gone.map((f) => `"${f}"`).join(', ')}`;
  }

  /** The facts as the Markdown file they are saved as. */
  markdown(): string {
    return `${HEADER}${this.#facts.map((f) => `- ${f}`).join('\n')}${this.#facts.length > 0 ? '\n' : ''}`;
  }

  /** Settles once every save so far has finished. */
  flush(): Promise<void> {
    return this.#saving;
  }

  /** The fact `words` names: an exact match, otherwise the first containing them (-1 if none). */
  #find(words: string): number {
    const key = normal(words);
    if (!key) return -1;
    const exact = this.#facts.findIndex((f) => normal(f) === key);
    return exact >= 0 ? exact : this.#facts.findIndex((f) => normal(f).includes(key));
  }

  #changed(): void {
    this.#onChange(this.#facts);
    const store = this.#store;
    if (!store) return;
    const markdown = this.markdown();
    this.#saving = this.#saving.then(() => store.save(markdown)).catch((error: unknown) => this.#onError(error));
  }
}
