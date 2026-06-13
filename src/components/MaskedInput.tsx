import { useState } from "react";

/**
 * A credential text input that is masked by default but can be revealed with a
 * Show/Hide toggle, so the user can check what they typed and avoid mistakes.
 * Renders as a `flex-1` field meant to sit alongside Save/Clear buttons.
 */
export function MaskedInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative flex-1">
      <input
        type={revealed ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 pr-14 text-sm outline-none focus:border-zinc-500"
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        aria-label={revealed ? "Hide value" : "Show value"}
        aria-pressed={revealed}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-xs text-zinc-400 hover:text-zinc-200"
      >
        {revealed ? "Hide" : "Show"}
      </button>
    </div>
  );
}
