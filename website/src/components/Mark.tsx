/** The site's mark: two linked squares. */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="3" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="3" />
      <rect x="13" y="13" width="16" height="16" rx="3" fill="currentColor" />
    </svg>
  );
}
