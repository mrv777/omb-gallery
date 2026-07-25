/**
 * Halved avocado, drawn to match the house icon style: 16×16 box, no fill,
 * 1.25 currentColor stroke, round joins — same as BellIcon and the modal's
 * info/close glyphs.
 *
 * Modelled on the 🥑 emoji rather than a generic pear: the neck is narrow, the
 * bowl is nearly the full width of the box, and the whole thing leans ~10°,
 * which is what stops it reading as a lightbulb at nav size. The lean matches
 * the emoji's direction — tip up-and-left over a bowl that sits down-and-right.
 * The pit is the one filled element: at 15px an outlined ring closes up into a
 * smudge, and a real pit is solid anyway.
 *
 * Decorative by default (`aria-hidden`); callers that use it as the only
 * content of a link must put the accessible name on the link itself.
 */
export default function AvocadoIcon({
  size = 15,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <g transform="rotate(10 8 8)">
        <path d="M8 2.1c-1.1 0-1.7 1.35-2 2.9-.28 1.45-2.5 2.6-2.5 4.95a4.5 4.5 0 0 0 9 0c0-2.35-2.22-3.5-2.5-4.95-.3-1.55-.9-2.9-2-2.9Z" />
        <circle cx="8" cy="10.7" r="1.75" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
