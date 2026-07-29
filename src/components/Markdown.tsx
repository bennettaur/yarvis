import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/url";

/**
 * Tailwind-styled element overrides for rendered markdown. The project has no
 * typography plugin, so each element is styled explicitly to match the dark UI.
 */
const components: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    // The webview has no status bar, so the destination is only visible on
    // hover — link text is free to claim it points somewhere else.
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className="text-sky-400 hover:underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = (className ?? "").includes("language-");
    if (isBlock) {
      return (
        <code className="block overflow-x-auto rounded-md bg-zinc-900 p-3 font-mono text-xs text-zinc-200">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-zinc-200">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-2">{children}</pre>,
  table: ({ children }) => (
    <table className="my-2 w-full border-collapse text-xs">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-zinc-700 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-zinc-800 px-2 py-1">{children}</td>,
};

/**
 * Stands in for an image rather than fetching it. An inline `<img>` reaches its
 * host the moment it renders, so any text we display — model replies above all,
 * since a prompt injection can put a URL of its choosing in one — could smuggle
 * what it saw out in the query string. The host is shown so the destination is
 * known before the click that opens it in the browser.
 */
const deferredImage: Components["img"] = ({ src, alt }) => {
  const href = typeof src === "string" ? src : "";
  let host = href;
  try {
    host = new URL(href).host || href;
  } catch {
    // Relative or malformed src: show it as-is.
  }
  return (
    <button
      type="button"
      onClick={() => openExternal(href)}
      title={href}
      className="my-1 inline-flex max-w-full items-baseline gap-1 truncate rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
    >
      <span className="text-zinc-500">Image</span>
      <span className="truncate">{alt || host}</span>
    </button>
  );
};

const componentsWithDeferredImages: Components = { ...components, img: deferredImage };

/** Renders GitHub-flavored markdown with the app's dark styling. */
export default function Markdown({
  children,
  className = "text-sm text-zinc-300",
  allowImages = false,
}: {
  children: string;
  /** Replaces — rather than extends — the wrapper's base text size and color. */
  className?: string;
  /**
   * Load images inline. Opt in only where the source is a document the user
   * asked to see (a PR or issue body); leave it off for generated text.
   */
  allowImages?: boolean;
}): ReactNode {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={allowImages ? components : componentsWithDeferredImages}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
