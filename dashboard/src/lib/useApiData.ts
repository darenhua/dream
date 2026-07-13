import { useCallback, useEffect, useRef, useState } from "react";

// Light per-panel data hook: each panel owns its fetch + refresh; no global
// Promise.all orchestrator.
export function useApiData<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetcher()
      .then(result => {
        if (alive.current) {
          setData(result);
          setError(null);
        }
      })
      .catch(e => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}
