/**
 * The Important marker: our own drawing of the shape Gmail uses for importance — a tag notched on the left and pointed
 * on the right. Filled, with lucide's 2px rounded stroke round it so it sits in the same
 * family as the stroked icons beside it. Not Gmail's asset.
 */
export function ImportantMarker({
  size = 24,
  strokeWidth = 2,
  className,
  viewBox = "0 0 24 24",
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
  viewBox?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      data-icon="important-marker"
    >
      <path d="M3 6h12.5l5 6-5 6H3l4.5-6z" />
    </svg>
  );
}
