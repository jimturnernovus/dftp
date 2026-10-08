// A shared button. Every <Button> on the page is drawn by the <button> line
// below, so its data-loc points here; the designer records where each one is
// used (used_in) so a change can be made at the usage site.
export function Button({ variant = "solid", children, ...rest }) {
  return (
    <button type="button" className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}
