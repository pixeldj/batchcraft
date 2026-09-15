import { useEffect, useEffectEvent, useRef, useState } from "react";

export function LibrarySearch({ label, query, scope, active = true, onChange }: { label: string; query: string; scope: string; active?: boolean; onChange(value: string): void }) {
  const [value, setValue] = useState(query);
  const [previous, setPrevious] = useState({ query, scope, active });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (previous.query !== query || previous.scope !== scope || previous.active !== active) {
    setPrevious({ query, scope, active });
    setValue(query);
  }
  const commit = useEffectEvent(() => { if (active && value !== query) onChange(value); });
  useEffect(() => {
    if (!active || value === query) return;
    timer.current = setTimeout(() => commit(), 300);
    return () => clearTimeout(timer.current);
  }, [value, query, scope, active]);
  return <label className="field global-library-search"><span className="field-label">{label}</span><input type="search" maxLength={200} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
    if (event.key !== "Enter") return;
    event.preventDefault(); clearTimeout(timer.current);
    if (active && value !== query) onChange(value);
  }} /></label>;
}
