import { describe, expect, it } from "bun:test";
import { createSentenceSplitter, speakableText } from "./speechChunks";

/**
 * Feeds a whole reply one character at a time, as a stream would. `minChars` is
 * lowered from the production default so short test sentences still stand on
 * their own.
 */
function splitStream(text: string, chunkSize = 1): string[] {
  const splitter = createSentenceSplitter({ minChars: 5 });
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(...splitter.push(text.slice(i, i + chunkSize)));
  }
  out.push(...splitter.flush());
  return out;
}

describe("speakableText", () => {
  it("drops markdown that reads as noise", () => {
    expect(speakableText("## Heading")).toBe("Heading");
    expect(speakableText("**bold** and _italic_")).toBe("bold and italic");
    expect(speakableText("see [the docs](https://example.com/x)")).toBe("see the docs");
    expect(speakableText("- first\n- second")).toBe("first second");
    expect(speakableText("run `bun test` now")).toBe("run bun test now");
  });

  it("collapses whitespace so a chunk reads as one line", () => {
    expect(speakableText("a\n\n  b\t c")).toBe("a b c");
  });
});

describe("createSentenceSplitter", () => {
  it("emits a sentence as soon as it is complete", () => {
    const splitter = createSentenceSplitter({ minChars: 5 });
    expect(splitter.push("Hello there. ")).toEqual(["Hello there."]);
    expect(splitter.push("Still going")).toEqual([]);
    expect(splitter.flush()).toEqual(["Still going"]);
  });

  it("does not split a decimal or an abbreviation", () => {
    expect(splitStream("The build takes 3.5 minutes on average, roughly. Done.")).toEqual([
      "The build takes 3.5 minutes on average, roughly.",
      "Done.",
    ]);
  });

  it("holds a terminator until the following character arrives", () => {
    const splitter = createSentenceSplitter({ minChars: 5 });
    // A trailing "." could still be "3.5"; nothing is emitted until the space
    // proves the sentence ended.
    expect(splitter.push("Ready to go.")).toEqual([]);
    expect(splitter.push(" ")).toEqual(["Ready to go."]);
  });

  it("keeps a short sentence with the next one rather than speaking it alone", () => {
    const splitter = createSentenceSplitter();
    // "Sure." is well under the default minimum, so it rides along with the
    // sentence that follows it.
    expect(
      splitter.push("Sure. That change landed in the sidecar earlier this morning, yes. "),
    ).toEqual(["Sure. That change landed in the sidecar earlier this morning, yes."]);
  });

  it("breaks a paragraph on a newline regardless of length", () => {
    expect(splitStream("Yes\nNo")).toEqual(["Yes", "No"]);
  });

  it("cuts an unpunctuated run at a word break", () => {
    const splitter = createSentenceSplitter({ minChars: 5, maxChars: 20 });
    const chunks = splitter.push(`${"word ".repeat(10)}`);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
  });

  it("drops fenced code instead of reading it aloud", () => {
    expect(splitStream("Here it is:\n```ts\nconst x = 1;\n```\nThat is the whole change.")).toEqual(
      ["Here it is:", "That is the whole change."],
    );
  });

  it("drops a code block the stream ended in the middle of", () => {
    expect(splitStream("Try this:\n```ts\nconst x = 1;")).toEqual(["Try this:"]);
  });

  it("emits nothing for whitespace-only input", () => {
    expect(splitStream("   \n  ")).toEqual([]);
  });
});

/**
 * The synthesis route rejects anything past MAX_SPEECH_CHARS, and a rejected
 * chunk is a sentence the user never hears. Mirrored here rather than imported
 * because the sidecar is a separate workspace.
 */
const MAX_SPEECH_CHARS = 2000;

describe("chunks stay within the synthesis limit", () => {
  const paragraph = `${"This sentence has no early terminator and just keeps going ".repeat(60)}.`;

  it("holds however the deltas are chunked", () => {
    // A model that emits a whole paragraph in one event is the case that used
    // to produce an oversized chunk: the scan found a terminator far past the
    // cut-off and returned it.
    for (const deltaSize of [1, 7, 100, paragraph.length]) {
      const splitter = createSentenceSplitter();
      const chunks: string[] = [];
      for (let i = 0; i < paragraph.length; i += deltaSize) {
        chunks.push(...splitter.push(paragraph.slice(i, i + deltaSize)));
      }
      chunks.push(...splitter.flush());

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
      }
    }
  });

  it("holds for one enormous delta with no sentence ends at all", () => {
    const splitter = createSentenceSplitter();
    const chunks = [...splitter.push("word ".repeat(2000)), ...splitter.flush()];
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });

  it("still speaks the whole paragraph, just in pieces", () => {
    const splitter = createSentenceSplitter();
    const spoken = [...splitter.push(paragraph), ...splitter.flush()].join(" ");
    // Nothing is dropped on the way through — the words all survive the split.
    expect(spoken.split(/\s+/).length).toBe(paragraph.trim().split(/\s+/).length);
  });
});
