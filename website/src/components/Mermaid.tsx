/**
 * A Mermaid diagram rendered at build time: its light SVG, shown unless the page is in dark mode, and its
 * dark SVG, shown in dark mode. Both are Mermaid's own output, rendered with securityLevel "strict".
 */
export function Mermaid({ light, dark }: { light: string; dark: string }) {
  return (
    <div className="my-6 overflow-x-auto [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full">
      <div className="dark:hidden" dangerouslySetInnerHTML={{ __html: light }} />
      <div className="hidden dark:block" dangerouslySetInnerHTML={{ __html: dark }} />
    </div>
  );
}
