import { useCallback, useState } from "react";

const GROUP_BY_CATEGORY_KEY = "yarvis.attention.groupByCategory";

/**
 * Whether the attention panel groups items by category. Kept between sessions,
 * since it is how the user likes to read the stream; on until they turn it off.
 */
export function useGroupByCategory(): [boolean, (value: boolean) => void] {
  const [grouped, setGrouped] = useState(() => localStorage.getItem(GROUP_BY_CATEGORY_KEY) !== "0");
  const set = useCallback((value: boolean) => {
    setGrouped(value);
    localStorage.setItem(GROUP_BY_CATEGORY_KEY, value ? "1" : "0");
  }, []);
  return [grouped, set];
}
