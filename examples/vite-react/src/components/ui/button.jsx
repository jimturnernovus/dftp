// A shared button. Every <Button> on the page is drawn by the <button> line
// below, so its data-loc points here; the designer records where each one is
// used (used_in) so a change can be made at the usage site. A className
// given to it is added to its own classes, never put in their place.
export function Button({ variant = "solid", className, children, ...rest }) {
  return (
    <button type="button" {...rest} className={[`btn btn-${variant}`, className].filter(Boolean).join(" ")}>
      {children}
    </button>
  );
}
