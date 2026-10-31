import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../../test/render";
import FlowDiagram from "./FlowDiagram";

describe("FlowDiagram", () => {
  it("draws nothing that isn't a flowchart, and still shows its source", async () => {
    const html = await renderToHtml(
      createElement(FlowDiagram, {
        flow: {
          title: "How an order is saved",
          explanation: "POST /orders validates, then writes.",
          mermaid: 'sequenceDiagram\n  a->>b: "hi"',
        },
      }),
    );
    const text = textOf(html);
    expect(text).toContain("How an order is saved");
    expect(text).toContain("POST /orders validates, then writes.");
    expect(text).toContain("The diagram isn't a flowchart");
    expect(text).toContain("sequenceDiagram");
    expect(html).not.toContain("<img");
  });

  it("shows only the explanation when there was no flow to draw", async () => {
    const html = await renderToHtml(
      createElement(FlowDiagram, {
        flow: { title: "No flow to draw", explanation: "Docs only.", mermaid: "" },
      }),
    );
    expect(textOf(html)).toContain("Docs only.");
    expect(html).not.toContain("Mermaid source");
    expect(html).not.toContain("Couldn't draw");
  });
});
