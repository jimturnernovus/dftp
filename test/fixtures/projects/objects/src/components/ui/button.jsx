export function Button({ variant = "primary", className, ...rest }) {
  return <button {...rest} className={[`btn btn-${variant}`, className].filter(Boolean).join(" ")} />;
}
