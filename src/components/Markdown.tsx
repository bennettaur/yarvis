import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { requestOpenPr } from "../lib/nav";
import { parsePrLink } from "../lib/prLink";
import { openExternal } from "../lib/url";

type LinkProps = { href?: string; children?: ReactNode };

const externalLink = ({ href, children }: LinkProps): ReactNode => (
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
);

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
  a: externalLink,
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
 * what it saw out in the query string. Inert on purpose: markdown images are
 * often wrapped in a link, and a control here would compete with that link's
 * click. The full source sits in the title for anyone who wants to look.
 */
const deferredImage: Components["img"] = ({ src, alt }) => {
  const source = typeof src === "string" ? src : "";
  let host = source;
  try {
    host = new URL(source).host || source;
  } catch {
    // Relative or malformed src: show it as-is.
  }
  return (
    <span
      title={source}
      className="my-1 inline-flex max-w-full items-baseline gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400"
    >
      <span className="text-zinc-500">Image</span>
      <span className="truncate">{alt || host}</span>
    </span>
  );
};

const componentsWithDeferredImages: Components = { ...components, img: deferredImage };

/** Plain text of a link's children, used as the title of the PR it opens. */
function textOfChildren(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOfChildren).join("");
  return "";
}

/**
 * A link that opens a PR inside Yarvis, with a small control (shown on hover)
 * to open it in the browser instead. Any other link keeps the default `a`.
 */
const appLink: Components["a"] = (props) => {
  const { href, children } = props;
  const pr = parsePrLink(href, textOfChildren(children));
  if (!pr) return externalLink(props);
  return (
    <span className="group inline-flex items-baseline gap-1">
      <a
        href={href}
        // Same hover-destination guarantee as externalLink: the assistant
        // (or third-party PR data it relays) chose the link text, so the
        // title has to carry the real URL, not just "Open in Yarvis".
        title={href}
        aria-label={`Open in Yarvis: ${href}`}
        onClick={(e) => {
          e.preventDefault();
          requestOpenPr(pr);
        }}
        className="text-sky-400 hover:underline"
      >
        {children}
      </a>
      <button
        type="button"
        title={`Open in browser: ${href}`}
        aria-label="Open in browser"
        onClick={() => openExternal(href)}
        className="text-xs text-zinc-500 opacity-0 hover:text-sky-400 focus:opacity-100 group-hover:opacity-100"
      >
        ↗
      </button>
    </span>
  );
};

/** Renders GitHub-flavored markdown with the app's dark styling. */
export default function Markdown({
  children,
  className = "text-sm text-zinc-300",
  allowImages = false,
  allowAppLinks = false,
}: {
  children: string;
  /** Replaces — rather than extends — the wrapper's base text size and color. */
  className?: string;
  /**
   * Load images inline. Opt in only where the source is a document the user
   * asked to see (a PR or issue body); leave it off for generated text.
   */
  allowImages?: boolean;
  /**
   * Open links to things Yarvis has a view for (PRs) inside the app, offering
   * the browser as a secondary choice. Off by default: a link in PR or issue
   * text is the author's, and the reader expects it to go where it says.
   */
  allowAppLinks?: boolean;
}): ReactNode {
  const base = allowImages ? components : componentsWithDeferredImages;
  return (
    <div className={className}>
      {/* remark-breaks keeps a single newline a line break, the way GitHub
          renders one — chat replies and issue bodies both rely on it. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={allowAppLinks ? { ...base, a: appLink } : base}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
