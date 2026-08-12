import { afterEach, describe, expect, it } from "bun:test";
import { buildFileTree } from "../../lib/fileTree";
import { mountForInteraction } from "../../test/render";
import FileTreeRows, { treeRowPaddingLeft } from "./FileTreeRows";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

const mount = async (paths: string[]) => {
  const mounted = await mountForInteraction(
    <ul>
      <FileTreeRows
        nodes={buildFileTree(paths, (path) => path)}
        renderFile={(node, depth) => (
          <div data-path={node.path} style={{ paddingLeft: treeRowPaddingLeft(depth) }}>
            {node.name}
          </div>
        )}
      />
    </ul>,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

const paddingLeft = (el: Element | null) =>
  el ? Number.parseFloat((el as HTMLElement).style.paddingLeft) : Number.NaN;

describe("FileTreeRows", () => {
  it("puts each file inside the folder row it belongs to", async () => {
    const host = await mount(["src/a.ts", "src/b.ts"]);
    expect([...host.querySelectorAll("details > summary")].map((s) => s.textContent)).toEqual([
      "▶src",
    ]);
    // Nested inside the `<details>`, so collapsing the folder hides the files.
    expect(host.querySelector('details ul [data-path="src/a.ts"]')).not.toBeNull();
    expect(host.querySelector('details ul [data-path="src/b.ts"]')).not.toBeNull();
  });

  it("opens folders by default", async () => {
    const host = await mount(["src/a.ts"]);
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("indents each level deeper than the one above it", async () => {
    const host = await mount(["src/a/one.ts", "src/b/two.ts"]);
    const summaries = [...host.querySelectorAll("details > summary")];
    const root = paddingLeft(summaries[0]);
    const nested = paddingLeft(summaries[1]);
    const file = paddingLeft(host.querySelector('[data-path="src/a/one.ts"]'));
    expect(root).toBe(8);
    expect(nested).toBeGreaterThan(root);
    expect(file).toBeGreaterThan(nested);
  });

  it("renders a root-level file with no folder around it", async () => {
    const host = await mount(["README.md"]);
    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector('[data-path="README.md"]')).not.toBeNull();
  });
});
