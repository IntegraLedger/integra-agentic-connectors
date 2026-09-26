"use client";

import { useEffect, useId, useState } from "react";

/** Whether the page is in dark mode: the theme provider sets the `dark` class on <html>. */
function useDark(): boolean | undefined {
  const [dark, setDark] = useState<boolean>();
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Renders a Mermaid diagram in the browser, in the theme the reader has selected. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = useDark();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (dark === undefined) return;
    let cancelled = false;
    void (async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
        fontFamily: "inherit",
      });
      try {
        const { svg } = await mermaid.render(`mermaid-${id}-${dark ? "dark" : "light"}`, chart);
        if (!cancelled) {
          setSvg(svg);
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id, dark]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-lg border p-4 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }
  if (!svg) {
    return (
      <pre className="overflow-x-auto rounded-lg border p-4 text-sm text-fd-muted-foreground">
        <code>{chart}</code>
      </pre>
    );
  }
  return (
    <div
      className="my-6 flex justify-center overflow-x-auto [&_svg]:max-w-full"
      // Mermaid's own output, rendered with securityLevel "strict".
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
